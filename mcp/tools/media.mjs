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
import { startVideo, videoStatus, framesFor, extractFrames, makeVideoSheet, videoMetrics, H3PromptCheckError } from '../lib/video.mjs';
import { formatH3Problems } from '../lib/h3protocol.mjs';
import { lintPrompt, lintWithLLM, readPromptFile } from '../lib/promptlint.mjs';
import * as C from './ctx.mjs';
// 工具体内用的是裸名，这里把共享上下文给齐
const {
  server, J, text, fail, norm, gb, trimMetrics, inspectImages, resolveWorkflow, preflight,
  latentSize, queuePosition, executionFailure, viewHint, visualPayload, logActivity, submitShape,
  EDIT_DIR, withControl, editWorkflow, finishEdit, pollMany, summarizeEntries, newestOutputs,
  inputDir, resolveVideoPath,
} = C;
// 本文件注册 3 个工具：comfy_video, comfy_lint_prompt, comfy_transition_prompt

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
    allow_invalid_prompt: z.boolean().optional().describe('start 用：跳过 H3 提示词结构校验（默认 false）。只用于复刻旧稿/对照实验；结构坏了 ComfyUI 不会报错，只会跑偏'),
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
        let started;
        try {
          started = await startVideo({
          mode,
          image: a.image, prompt: a.prompt,
          width: a.width ?? (mode === '2pass' ? 608 : 1280),
          height: a.height ?? (mode === '2pass' ? 352 : 736),
          outW: a.out_width, outH: a.out_height,
          seconds: a.seconds ?? 5,
          steps: a.steps ?? (mode === '2pass' ? 12 : 8),
          // 只有调用者显式要"独立短曲线"时才传这两项。
          // 以前写死成 ?? 4 / ?? 0.35，等于每次调用都强制二采重新加噪 35%，
          // 会把音频 latent 一起重采样（实测退化成谐波嗡鸣）。不传就走 SplitSigmas 8+4。
          ...(a.refine_steps != null || a.refine_denoise != null
            ? { refineSteps: a.refine_steps, refineDenoise: a.refine_denoise }
            : {}),
          scale: a.scale ?? 2,
          chunk: a.chunk_frames ?? 153,
          overlap: a.overlap_frames ?? 17,
          upscalerPrecision: a.upscaler_precision ?? 'fp16',
          seed: a.seed ?? Math.floor(Math.random() * 1e9),
          prefix: a.prefix ?? 'comfyforge/video',
          allowInvalidPrompt: a.allow_invalid_prompt === true,
          });
        } catch (e) {
          // 结构不合格时不提交，把问题清单直接给 agent 自己改
          if (e instanceof H3PromptCheckError) {
            return fail(`提示词结构没通过，已拦在提交前（**没有发起执行**）：\n${formatH3Problems(e.problems)}`, {
              mode: e.mode,
              problems: e.problems,
              hint: '按官方规范改：字段名与顺序固定、首镜不写时间码、后续 At MM:SS.mmm 严格递增、<d> 成对、'
                + '声源按首次发声顺序 (S1)(S2)…、参考标签必须先定义、不得出现 negative 字段。'
                + '确实要照旧提交就传 allow_invalid_prompt=true。',
            });
          }
          throw e;
        }
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

server.tool(
  'comfy_transition_prompt',
  '「中间态」提示词编译器：把「A 变成 B」编译成模型画得出来的空间描述。扩散模型没有时间轴，「正在变成」没有对应像素——只能靠"同一具身体上一部分已经变了、一部分还没变、交界处留下正在推进的物理痕迹"。这个工具负责分区归属 + 交界机制 + 必须不变的特征，直接产出可喂给 MOSS/FLUX.2/Krea2 的正负提示词。action=build 编译；list 看可选的分区轴/交界机制；example 看现成例子。',
  {
    action: z.enum(['build', 'list', 'example']).optional().describe('build（默认）=编译；list=列出可选值；example=输出一个现成例子'),
    from: z.string().optional().describe('起点：静态地描述"原来是什么、长什么样"（不是"正在变成什么"）'),
    to: z.string().optional().describe('终点：静态地描述"变成之后长什么样"'),
    from_detail: z.string().optional().describe('起点最显眼的 2–3 个特征（材质、颜色、轮廓）'),
    to_detail: z.string().optional().describe('终点最显眼的 2–3 个特征——不给效果损失最大'),
    from_feature: z.string().optional().describe('起点最显眼的材质，如"塑料外壳"（交界模板要用）'),
    to_feature: z.string().optional().describe('终点最显眼的材质，如"灰毛"（交界模板要用）'),
    progress: z.number().min(0).max(1).optional().describe('变化到多少（0–1，默认 0.6）。太小或太大会被提醒"不如直接画起点/终点"'),
    axis: z.string().optional().describe('分区轴，如 near->far / left->right / bottom->top / root->tip / center->out。用 action=list 看全部'),
    boundary: z.string().optional().describe('交界机制，如 crack 顶裂 / bloom 生长 / shed 剥落 / melt 融化 / dissolve 溶解 / stitch 缝合 / glow 发光 / wet 黏液 / burn 灼烧 / crystal 结晶'),
    keep: z.array(z.string()).optional().describe('必须保持不变的特征（越写越稳，模型不容易把整个角色重画）'),
    scene: z.string().optional().describe('背景/环境/光'),
    style: z.enum(['anime', 'realistic', 'illustration', 'cinematic', 'threed']).optional().describe('画风'),
    subjects: z.array(z.any()).optional().describe('多主体：[{name, from, to, progress, axis, boundary, position, ...}]，静态角色用 {name, desc, position}'),
    example: z.string().optional().describe('example 用：mouse / magical / alien'),
    json: z.boolean().optional().describe('只要机器可读的结果'),
  },
  async (a) => {
    try {
      const T = await import('../lib/transition.mjs');
      if (a.action === 'list') {
        return text({
          axes: Object.fromEntries(Object.entries(T.AXES).map(([k, v]) => [k, `${v.kind}：${v.zh.changed} 已变 / ${v.zh.intact} 未变`])),
          boundaries: Object.fromEntries(Object.entries(T.BOUNDARIES).map(([k, v]) => [k, v.fits])),
          styles: Object.keys(T.STYLES),
          examples: Object.fromEntries(Object.entries(T.EXAMPLES).map(([k, v]) => [k, v.label])),
        });
      }
      if (a.action === 'example' || a.example) {
        const ex = T.EXAMPLES[a.example || 'mouse'];
        if (!ex) return fail(`没有叫 "${a.example}" 的例子。有：${Object.keys(T.EXAMPLES).join(', ')}`);
        const r = T.buildTransition(ex.spec);
        return text({ ok: r.ok, label: ex.label, prompt: r.prompt, negative: r.negative, warnings: r.warnings, notes: r.notes, spec: ex.spec });
      }

      const spec = a.subjects?.length ? { subjects: a.subjects } : {
        from: a.from, to: a.to, fromDetail: a.from_detail, toDetail: a.to_detail,
        fromFeature: a.from_feature, toFeature: a.to_feature,
      };
      Object.assign(spec, {
        progress: a.progress, axis: a.axis, boundary: a.boundary, keep: a.keep,
        scene: a.scene, style: a.style,
      });
      for (const k of Object.keys(spec)) if (spec[k] === undefined) delete spec[k];
      if (!spec.subjects && !spec.from && !spec.to) {
        return fail('需要 from + to（单主体），或 subjects（多主体）。先跑 action=list 看可选值。');
      }

      const r = T.buildTransition(spec);
      return text({
        ok: r.ok, prompt: r.prompt, negative: r.negative,
        warnings: r.warnings, notes: r.notes,
        chars: { prompt: [...r.prompt].length, negative: [...r.negative].length },
        note: '把 prompt 直接当正向提示词用。负向只在 CFG>1 时有效（FLUX.2 的 cfg=1，负向白算）。',
      });
    } catch (e) {
      return fail(e.message, { hint: e.details ? undefined : '分区轴/交界机制的名字要写对，先跑 action=list' });
    }
  },
);
