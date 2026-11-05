// tools/view.mjs —— view 域的工具注册（从 server.mjs 机械搬移，逻辑未改）
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
// 本文件注册 7 个工具：comfy_image, comfy_look, comfy_region, comfy_triage, comfy_snapshot, comfy_inspect, comfy_picks

server.tool(
  'comfy_image',
  '，filename + subfolder 取一张图，返回图片本身与客观指标。文件名带目录时要拆开传（如 filename="out_00001_.png", subfolder="comfyforge"）。',
  {
    filename: z.string(),
    subfolder: z.string().default(''),
    type: z.enum(['output', 'temp', 'input']).default('output'),
    inspect: z.boolean().default(true),
    max_side: z.number().int().min(256).max(2048).default(1280),
  },
  async (args) => {
    try {
      let file = { filename: args.filename, subfolder: args.subfolder, type: args.type };
      if (args.filename.includes('/')) {
        const parts = args.filename.split('/');
        file = { filename: parts.pop(), subfolder: parts.join('/'), type: args.type };
      }
      const m = await materialize(file);
      let met = null;
      let metricError = null;
      if (args.inspect) {
        try { met = imgMetrics([m.path])[0]; } catch (e) { metricError = e.message; }
      }
      const p = previewFor(m.path, { maxSide: args.max_side });
      const payload = {
        ok: true, path: m.path, source: m.source, bytes: m.bytes,
        width: met?.width, height: met?.height,
        quality: trimMetrics(met), metric_error: metricError,
        image_url: `${BASE}/view?filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder)}&type=${file.type}`,
        returned: { mode: p.mode, bytes: p.bytes, mime: p.mimeType },
      };
      return { content: [{ type: 'text', text: J(payload) }, { type: 'image', data: p.data, mimeType: p.mimeType }] };
    } catch (e) {
      return fail(`取图失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_look',
  '整体看：把图缩到能判断气质构图的大小（默认 900px），可选坐标网格（标签是原图坐标）。美术先看整体，别一上来抠细节。',
  {
    image: z.string().describe('本地绝对路径，或 ComfyUI 产物 filename'),
    subfolder: z.string().default(''),
    max: z.number().int().min(256).max(1600).default(900),
    grid: z.number().int().min(0).max(500).default(0).describe('每 N 像素画一条带原图坐标的网格线；=不画'),
  },
  async (args) => {
    try {
      const path = existsSync(args.image) ? args.image : (await materialize({ filename: args.image, subfolder: args.subfolder })).path;
      const r = lookAt(path, { max: args.max, grid: args.grid });
      const p = previewFor(r.path, { maxSide: args.max });
      return {
        content: [
          { type: 'text', text: J({ ok: true, source: path, size: `${r.width}x${r.height}`, preview: `${r.preview_width}x${r.preview_height}`, scale: r.scale, grid: r.grid }) },
          { type: 'image', data: p.data, mimeType: p.mimeType },
        ],
      };
    } catch (e) {
      return fail(`整体看失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_region',
  '局部看：按原图坐标裁一块并放大（默认放大到 900px），用来看手、脸、文字、接缝。配合 comfy_look 的坐标网格用。',
  {
    image: z.string().describe('本地绝对路径，或 ComfyUI 产物 filename'),
    subfolder: z.string().default(''),
    box: z.array(z.number()).length(4).describe('[x, y, w, h]，原图坐标'),
    max: z.number().int().min(200).max(1400).default(900),
  },
  async (args) => {
    try {
      const path = existsSync(args.image) ? args.image : (await materialize({ filename: args.image, subfolder: args.subfolder })).path;
      const r = regionOf(path, args.box, { max: args.max });
      const p = previewFor(r.path, { maxSide: args.max });
      return {
        content: [
          { type: 'text', text: J({ ok: true, source: path, box: r.box, scale: r.scale, size: `${r.width}x${r.height}` }) },
          { type: 'image', data: p.data, mimeType: p.mimeType },
        ],
      };
    } catch (e) {
      return fail(`局部看失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_triage',
  '淘汰/清理：只按客观缺陷判定，不做审美判断。图片看「读不出 / 近似纯色 / 死糊 / 过小 / 重复」，视频看「大小 / 时长 / 读不出」。执行时移到 _trash/ 并写 manifest，不删除；picks 里的图永不移动；可 restore 一键恢复。',
  {
    dir: z.string().optional().describe('输出目录名（如 anime）或绝对路径；默认整个输出根目录'),
    action: z.enum(['scan', 'apply', 'restore']).default('scan'),
    batch: z.string().optional().describe('restore 时指定某个垃圾桶批次（默认最近一次）'),
  },
  async (args) => {
    try {
      const dir = resolveDir(args.dir);
      if (args.action === 'scan') return text({ ok: true, ...triageScan(dir) });
      if (args.action === 'apply') return text({ ok: true, ...triageApply(dir) });
      return text({ ok: true, ...triageRestore(dir, args.batch) });
    } catch (e) {
      return fail(`清理失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_snapshot',
  '快照：把最近 N 张（或指定几张）图拼成一张带编号/尺寸/锐度的联络表返回 —— 一次就能看完一批结果，适合对比参数、挑图。',
  {
    latest: z.number().int().min(1).max(12).default(4).describe('取输出目录里最新的 N 张'),
    images: z.array(z.object({ filename: z.string(), subfolder: z.string().default(''), type: z.string().default('output') })).optional().describe('指定要看的图；给了就不看 latest'),
    cols: z.number().int().min(1).max(4).default(2),
    cell: z.number().int().min(240).max(1024).default(560),
    include_metrics: z.boolean().default(true),
  },
  async (args) => {
    try {
      let files = [];
      if (args.images?.length) {
        files = args.images.map((f) => ({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' }));
      } else {
        files = newestOutputs(args.latest);
      }
      if (!files.length) return fail(`输出目录里没有图片：${OUTPUT_DIR}`);

      const rows = [];
      for (const f of files) {
        try {
          const m = await materialize(f);
          rows.push({ ...f, path: m.path, bytes: m.bytes });
        } catch (e) {
          rows.push({ ...f, error: e.message });
        }
      }
      const usable = rows.filter((r) => r.path);
      if (!usable.length) return fail('这些图都取不到（文件不存在或 ComfyUI 取图失败）', { rows });
      const sheet = makeSheet(usable.map((r) => r.path), { cols: args.cols, cell: args.cell });
      const p = previewFor(sheet.out, { maxSide: 1600 });
      const payload = {
        ok: true,
        sheet: sheet.out,
        count: sheet.count,
        grid: `${args.cols}x${Math.ceil(sheet.count / args.cols)}`,
        images: sheet.metas.map((m, i) => ({
          index: i + 1, filename: m.filename, width: m.width, height: m.height,
          lap_var_512: m.lap_var_512, edge_pct: m.edge_pct,
          verdict: args.include_metrics ? m.verdict : undefined,
        })),
        note: '图里每格上方有编号、文件名、尺寸、锐度；右下角是判定等级。',
      };
      return { content: [{ type: 'text', text: J(payload) }, { type: 'image', data: p.data, mimeType: p.mimeType }] };
    } catch (e) {
      return fail(`快照失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_inspect',
  '只做客观体检（不返回图）：分辨率是否达原生 1MP、锐度、边缘密度、裁切、对比、九宫格局部情况，并给出判定与原因。可传本地路径或 ComfyUI 产物。',
  {
    paths: z.array(z.string()).optional().describe('本地绝对路径'),
    images: z.array(z.object({ filename: z.string(), subfolder: z.string().default(''), type: z.string().default('output') })).optional(),
    include_image: z.boolean().default(false).describe('只有 1 张时，是否顺带把图返回'),
  },
  async (args) => {
    try {
      const paths = [];
      for (const p of args.paths || []) if (existsSync(p)) paths.push(p);
      for (const f of args.images || []) {
        try { paths.push((await materialize(f)).path); } catch { /* skip */ }
      }
      if (!paths.length) return fail('没有可检查的图片：传 paths（本地路径）、images（ComfyUI 产物）');
      const list = imgMetrics(paths);
      const summary = list.map((m) => `${m.filename}: ${m.width}x${m.height} ${m.verdict.level}${m.verdict.flags.length ? '(' + m.verdict.flags.join(',') + ')' : ''}`);
      const payload = { ok: true, count: list.length, summary, images: list };
      if (args.include_image && list.length === 1) {
        const p = previewFor(paths[0], { maxSide: 1280 });
        return { content: [{ type: 'text', text: J(payload) }, { type: 'image', data: p.data, mimeType: p.mimeType }] };
      }
      return text(payload);
    } catch (e) {
      return fail(`体检失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_picks',
  '精选清单：把我/你挑中的图记下来（dashboard 里点「选中」也是写这份），list 回看，add/remove/clear 维护。',
  {
    action: z.enum(['list', 'add', 'remove', 'clear']).default('list'),
    filename: z.string().optional(),
    subfolder: z.string().default(''),
    prompt_id: z.string().optional(),
    note: z.string().default(''),
  },
  async (args) => {
    try {
      if (args.action === 'list') return text({ ok: true, ...listPicks() });
      if (args.action === 'clear') return text({ ok: true, ...clearPicks() });
      if (!args.filename) return fail(`${args.action} 需要 filename`);
      if (args.action === 'add') {
        return text({ ok: true, ...addPick({ filename: args.filename, subfolder: args.subfolder, prompt_id: args.prompt_id, note: args.note }) });
      }
      return text({ ok: true, ...removePick(keyOf(args.filename, args.subfolder)) });
    } catch (e) {
      return fail(`精选清单操作失败：${e.message}`);
    }
  },
);
