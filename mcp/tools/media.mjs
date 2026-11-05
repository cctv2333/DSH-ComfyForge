// tools/media.mjs —— media 域的工具注册（从 server.mjs 机械搬移，逻辑未改）
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { extname, join, dirname, basename, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  BASE, OUTPUT_DIR, WORKFLOW_DIR, RUNS_DIR, COMFY_ROOT, PROJECT_ROOT, LOG_PATH, MODE, ComfyError,
  systemStats, queueState, historyResolved, recentHistory, objectInfo, submit, waitFor,
  parseHistoryEntry, interrupt, deleteFromQueue, localOutputPath, sleep, POLL_MS, NOT_QUEUED_GRACE_MS,
} from '../lib/comfy.mjs';
import { metrics as imgMetrics, makeSheet, materialize, previewFor } from '../lib/img.mjs';
import {
  getTemplate, listTemplates, saveTemplate, deleteTemplate,
  resolveTemplate, validateWorkflow, saveRun, listRuns, ensureDirs,
} from '../lib/templates.mjs';
import { readLog, lastTraceback, explainException } from '../lib/diag.mjs';
import { rememberRun, rememberLesson, recallLessons, stats as memoryStats, setPending, takePending } from '../lib/memory.mjs';
import { checkSize, modelFromWorkflow, listProfiles, profileFor, loadRegistry, saveRegistry } from '../lib/models.mjs';
import { addPick, removePick, listPicks, clearPicks, keyOf } from '../lib/picks.mjs';
import { uploadImage, makeMask, diffImages, compositeImages, placePrep, edgeControl, keyMask } from '../lib/edit.mjs';
import { lookAt, regionOf } from '../lib/view.mjs';
import { scan as triageScan, apply as triageApply, restore as triageRestore, resolveDir } from '../lib/triage.mjs';
import { append as journalAppend, list as journalList, search as journalSearch, paths as journalPaths } from '../lib/journal.mjs';
import { runChecks } from '../lib/doctor.mjs';
import { auditModels } from '../lib/modelfiles.mjs';
import {
  listWorkflows, inspectWorkflow, installedPacks, classifyNodes, renderWorkflowDoc, writeDoc, workflowDir,
} from '../lib/workflows.mjs';
import { checkWorkflows, formatReport } from '../lib/workflowcheck.mjs';
import { startVideo, videoStatus, framesFor, extractFrames, makeVideoSheet, videoMetrics } from '../lib/video.mjs';
import { lintPrompt, lintWithLLM, readPromptFile } from '../lib/promptlint.mjs';
import * as C from './ctx.mjs';
// 工具体内用的是裸名，这里把共享上下文给齐
const {
  server, J, text, fail, norm, gb, trimMetrics, inspectImages, resolveWorkflow, preflight,
  latentSize, queuePosition, executionFailure, viewHint, visualPayload, logActivity, submitShape,
  EDIT_DIR, withControl, editWorkflow, finishEdit, pollMany, summarizeEntries, newestOutputs,
} = C;
// 本文件注册 2 个工具：comfy_video, comfy_lint_prompt

server.tool(
  'comfy_video',
  'MiniMax H3 视频。mode=single 图生视频（i2v 单遍）；mode=2pass 参考图二采（r2v 低清一采 → 学习型 3D latent 放大 → MMH3 分块低噪声重采样，8GB 也能出 1216×704）。action=start 提交；status 继续等；frames/sheet 抽帧拼图；metrics 客观指标（帧间差分/黑帧/切点/音量），用于抽卡排序。',
  {
    action: z.enum(['start', 'status', 'frames', 'sheet', 'metrics']).describe('start=提交；status=查询/继续等；frames=抽帧；sheet=拼图；metrics=客观指标'),
    mode: z.enum(['single', '2pass']).optional().describe('start 用：single（默认）或 2pass（二采，必须给参考图而不是首帧）'),
    prompt_id: z.string().optional().describe('status 用'),
    image: z.string().optional().describe('start 用：ComfyUI input 目录里的图片文件名（single=首帧，2pass=参考图）'),
    prompt: z.string().optional().describe('start 用：提示词（2pass 建议用六段式，见 prompts/h3-r2v-提示词格式.md）'),
    seconds: z.number().optional().describe('start 用：目标秒数（会自动校正成 5+17k 帧，默认 5）'),
    width: z.number().optional().describe('生成宽，32 的倍数；single 默认 1280，2pass 默认 608'),
    height: z.number().optional().describe('生成高，32 的倍数；single 默认 736，2pass 默认 352'),
    out_width: z.number().optional().describe('single 用：输出宽（默认同 width）'),
    out_height: z.number().optional().describe('single 用：输出高（默认同 height）'),
    steps: z.number().optional().describe('采样步数；single 默认 8，2pass 默认 12（一采必须跑满）'),
    refine_steps: z.number().optional().describe('2pass 用：二采重采样步数（默认 4）'),
    refine_denoise: z.number().optional().describe('2pass 用：二采 denoise（默认 0.35；越高改得越多、越容易跑偏）'),
    scale: z.number().optional().describe('2pass 用：latent 放大倍数（默认 2；1–4）'),
    chunk_frames: z.number().optional().describe('2pass 用：二采时间块帧数，17 的倍数（默认 153，约 6.4 秒一块）'),
    overlap_frames: z.number().optional().describe('2pass 用：块间重叠，17 的倍数（默认 17）'),
    upscaler_precision: z.enum(['fp16', 'fp32', 'bf16']).optional().describe('2pass 用：3D 放大网络精度（默认 fp16）'),
    seed: z.number().optional(),
    prefix: z.string().optional().describe('产物前缀，默认 comfyforge/video'),
    wait_s: z.number().optional().describe('status 时本次最多等几秒，默认 45'),
    video: z.string().optional().describe('frames/sheet/metrics 用：本地绝对路径，或 output 里的相对路径'),
    times: z.array(z.number()).optional().describe('frames 用：要抽的秒数列表，默认 [1,3,5]'),
  },
  async (a) => {
    try {
      if (a.action === 'start') {
        const mode = a.mode ?? 'single';
        if (!a.image) return fail('start 需要 image（ComfyUI input 目录里的文件名）');
        if (!a.prompt) return fail('start 需要 prompt');
        if (!existsSync(join(inputDir(), a.image))) {
          const cands = existsSync(inputDir())
            ? readdirSync(inputDir()).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).slice(0, 6)
            : [];
          return fail(`input 目录里没有 ${a.image}`, { inputDir: inputDir(), candidates: cands });
        }
        const { frames, seconds } = framesFor(a.seconds ?? 5);
        const started = await startVideo({
          mode,
          image: a.image, prompt: a.prompt,
          width: a.width ?? (mode === '2pass' ? 608 : 1280),
          height: a.height ?? (mode === '2pass' ? 352 : 736),
          outW: a.out_width, outH: a.out_height,
          seconds: a.seconds ?? 5,
          steps: a.steps ?? (mode === '2pass' ? 12 : 8),
          refineSteps: a.refine_steps ?? 4,
          refineDenoise: a.refine_denoise ?? 0.35,
          scale: a.scale ?? 2,
          chunk: a.chunk_frames ?? 153,
          overlap: a.overlap_frames ?? 17,
          upscalerPrecision: a.upscaler_precision ?? 'fp16',
          seed: a.seed ?? Math.floor(Math.random() * 1e9),
          prefix: a.prefix ?? 'comfyforge/video',
        });
        const est = mode === '2pass'
          ? `一采约 ${Math.round(frames * 0.02)} 分钟 + 放大/二采（${started.params.chunkCount} 块）约 ${Math.round(frames * 0.02)} 分钟`
          : `预计 ${Math.round(frames * 0.075)} 分钟左右（本机 4.6 秒/帧）`;
        return text({
          ok: true, ...started,
          note: `已提交（${mode}），${est}。用 action=status + prompt_id 继续等，出片后 action=metrics 看客观指标。`,
          frames, seconds,
        });
      }

      if (a.action === 'status') {
        if (!a.prompt_id) return fail('status 需要 prompt_id');
        const st = await videoStatus(a.prompt_id, { waitS: a.wait_s ?? 45 });
        if (st.pending) return text({ ok: true, pending: true, ...st });
        return text({ ok: st.status === 'success', ...st });
      }

      if (a.action === 'frames' || a.action === 'sheet' || a.action === 'metrics') {
        const vp = resolveVideoPath(a.video);
        if (!vp) return fail('需要 video（本地绝对路径或 output 里的相对路径）');
        if (a.action === 'frames') {
          const made = extractFrames(vp, { times: a.times ?? [1, 3, 5] });
          return text({ ok: made.length > 0, video: vp, frames: made });
        }
        if (a.action === 'metrics') {
          const m = videoMetrics(vp);
          return text({
            ok: true, ...m,
            note: 'flicker 是相邻帧平均亮度差（0–255 尺度），越小越稳；cuts 是强切点，分镜内意外切点多说明画面在崩。',
          });
        }
        const sheet = makeVideoSheet(vp, { cols: 5 });
        return text({ ok: sheet.ok, ...sheet });
      }

      return fail(`未知 action: ${a.action}`);
    } catch (e) {
      return fail(e.message, { hint: e.kind === 'submit' ? '检查 image/prompt/分辨率步长（32 的倍数）或 2pass 的 split_step < steps' : undefined });
    }
  },
);

server.tool(
  'comfy_lint_prompt',
  '发出去之前自查 H3 r2v 提示词：段落齐全、<Picture n>/<Subject n> 引用闭合、[Shot n] 编号与时间码递增、手分工与声音同步是否每镜都写、帧数是否 5+17k、字数密度。纯规则、毫秒级、不联网；llm=true 时额外跑语义层（需要本地 Ollama/llama.cpp 端点，没有就打印装法，不自动下载）。',
  {
    file: z.string().optional().describe('提示词文件（纯文本，或带 prompt 字段的 JSON 配置）'),
    text: z.string().optional().describe('直接给提示词正文（与 file 二选一）'),
    seconds: z.number().optional().describe('目标时长，用于校验帧数与末尾时间码'),
    ref_images: z.number().optional().describe('实际给几张参考图，用于校验 <Picture n> 引用'),
    llm: z.boolean().optional().describe('额外跑语义层（可选，需要 OpenAI 兼容端点）'),
  },
  async (a) => {
    try {
      let promptText = a.text;
      let meta = {};
      if (!promptText) {
        if (!a.file) return fail('需要 file 或 text');
        // 绝对路径直接用；相对路径按工作区根目录解析
        const candidate = isAbsolute(a.file) ? a.file : join(PROJECT_ROOT, a.file);
        if (!existsSync(candidate)) return fail(`文件不存在：${a.file}`);
        ({ text: promptText, meta } = readPromptFile(candidate));
      }
      const rep = lintPrompt(promptText, { seconds: a.seconds ?? meta.seconds, refImages: a.ref_images });
      let llm = null;
      if (a.llm) {
        llm = await lintWithLLM(promptText);
        if (!llm.skipped) rep.issues.push(...llm.issues);
      }
      return text({
        ok: rep.ok, verdict: rep.verdict, score: rep.score,
        counts: rep.counts, stats: rep.stats,
        issues: rep.issues,
        ...(llm ? { llm: llm.skipped ? { skipped: llm.reason, setup: llm.setup } : { model: llm.model, count: llm.issues.length } } : {}),
        note: 'error 级必须改（会导致结构崩）；warn 级是"能跑但不够稳"；info 是加分项。',
      });
    } catch (e) {
      return fail(e.message);
    }
  },
);
