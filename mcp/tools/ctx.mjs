// tools/ctx.mjs —— 从 server.mjs 拆出来的共享上下文
//
// 内容 = 原 server.mjs 的 imports + helpers + 活动日志包装 + 工具块之间残留的域内小工具
// + 原本在文件尾部、但被工具块引用的 helper（如 newestOutputs）。
//
// 工具块用的全是裸名（text / fail / submit / getTemplate …），所以域文件会从这里解构。
// 导出名单是**扫出来的**（不是手写），少一个只会在调用那个工具时抛 ReferenceError。

// server.mjs — ComfyForge MCP (comfy-forge) v0.3.0
// 给「看得见图」的 agent 用的 ComfyUI 桥：
//   生成 → 等待 → 客观质检 → 一次看多张（联络表） → 按结果调参再跑
// 与 v0.1 的差别（v0.1 的问题见 docs/接入实测报告）：
//   - 取图能正确处理 subfolder（v0.1 把"comfyforge/out.png" 录 filename 直接 404）
//   - stdin 结束时不再 process.exit 打断未刷新的 stdout（v0.1 会触发 libuv assertion 崩溃）
//   - 所有 HTTP 请求带超时（v0.1 的 fetch 无超时，ComfyUI 卡住会永久挂起）
//   - 提交前用 /object_info 静态校验（未知节点/缺输入枚举不符/连线断），并拦截本机实测过的坑
//   - 执行失败时返回 ComfyUI 的 node_errors / 日志 traceback / 可执行建议，而不是一句"execution error"
//   - 产物默认自动算客观指标（分辨率锐度/裁切/对比），并可一次返回多图拼图，供视觉模型真正「看」
//   - 工作流模板库 + 运行记录，模板是纯 JSON，用户可手改
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

// 版本号从 package.json 读，避免这里和 package.json 各写一份、慢慢漂移。
const SERVER = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return { name: 'comfy-forge', version: pkg.version || '0.0.0' };
  } catch {
    return { name: 'comfy-forge', version: '0.0.0' };
  }
})();

// ---------------------------------------------------------------- helpers
const J = (o) => JSON.stringify(o, null, 2);
const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : J(o) }] });
const fail = (message, extra = {}) => ({
  content: [{ type: 'text', text: J({ ok: false, error: message, ...extra }) }],
  isError: true,
});
const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
const gb = (n) => (n / 1073741824).toFixed(2) + 'GB';

function trimMetrics(m) {
  if (!m) return null;
  return {
    width: m.width, height: m.height, megapixels: m.megapixels,
    lap_var_512: m.lap_var_512, edge_pct: m.edge_pct, contrast: m.contrast,
    clip_high: m.clip_high, clip_low: m.clip_low,
    verdict: m.verdict,
  };
}

/** 把产物落盘并逐张算指标；任何一张失败都不影响其它张 */
async function inspectImages(images) {
  const rows = [];
  for (const f of images) {
    try {
      const m = await materialize(f);
      rows.push({ ...f, path: m.path, source: m.source, bytes: m.bytes });
    } catch (e) {
      rows.push({ ...f, error: e.message });
    }
  }
  const usable = rows.filter((r) => r.path && !r.error);
  let metricList = [];
  let metricError = null;
  if (usable.length) {
    try {
      metricList = imgMetrics(usable.map((r) => r.path));
    } catch (e) {
      metricError = e.message;
    }
  }
  const byPath = new Map(metricList.map((m) => [norm(m.path), m]));
  for (const r of rows) {
    const m = byPath.get(norm(r.path || ''));
    if (m) { r.metrics = m; r.width = m.width; r.height = m.height; }
  }
  return { rows, metricError };
}

async function resolveWorkflow(args) {
  let workflow, applied = {}, warnings = [], templateName = null;
  if (args.workflow) {
    if (args.template) throw new Error('template 与 workflow 只能二选一');
    workflow = JSON.parse(JSON.stringify(args.workflow));
    if (args.params && Object.keys(args.params).length) {
      warnings.push('传了 workflow 又传 params：params 只能用于模板绑定，已忽略。');
    }
  } else if (args.template) {
    const tpl = getTemplate(args.template);
    templateName = args.template;
    const r = resolveTemplate(tpl, args.params || {});
    workflow = r.workflow;
    applied = r.applied;
    warnings = r.warnings;
  } else {
    throw new Error('需要 template（模板名）或 workflow（API 格式工作流）。用 comfy_templates 查看已有模板。');
  }
  return { workflow, applied, warnings, templateName };
}

async function preflight(workflow) {
  const info = await objectInfo();
  const v = validateWorkflow(workflow, info);
  // 分辨率不跟模板走，跟「用哪个模型」走
  const model = modelFromWorkflow(workflow);
  let size = null;
  if (model.file) {
    const dims = latentSize(workflow);
    if (dims) {
      size = checkSize(model.file, dims.width, dims.height);
      v.errors.push(...size.errors);
      v.warnings.push(...size.warnings);
      v.hints.push(...size.info);
    }
  }
  return { ...v, model, size };
}

/** 找出 latent 节点的宽高（决定出图尺寸的那一处） */
function latentSize(workflow) {
  for (const node of Object.values(workflow || {})) {
    const t = node?.class_type;
    if (t === 'EmptySD3LatentImage' || t === 'EmptyLatentImage' || t === 'EmptySDXLImage') {
      const w = Number(node.inputs?.width), h = Number(node.inputs?.height);
      if (w && h) return { width: w, height: h, node: t };
    }
  }
  return null;
}

async function queuePosition(promptId) {
  const q = await queueState();
  const idx = (q.queue_pending || []).findIndex((x) => x[1] === promptId);
  return { running: (q.queue_running || []).length, pending: (q.queue_pending || []).length, position: idx >= 0 ? idx + 1 : 0 };
}

function executionFailure(parsed) {
  const err = parsed.errors?.[0] || {};
  const tb = lastTraceback();
  const msg = err.exception_message || tb?.error_line || '执行失败（ComfyUI 未给出异常信息）';
  return {
    node: err.node_id ? { id: err.node_id, type: err.node_type } : undefined,
    exception_type: err.exception_type,
    exception_message: err.exception_message,
    traceback: err.traceback?.length ? err.traceback : tb?.frames,
    log_error: tb?.error_line || null,
    hints: explainException(msg),
  };
}

function viewHint(rows) {
  const bad = rows.filter((r) => r.metrics && r.metrics.verdict.level !== 'ok');
  if (!bad.length) return null;
  return bad.map((r) => `${r.filename}: ${r.metrics.verdict.flags.join(',') || r.metrics.verdict.level}`);
}

/** 附件：单图给图，多图给联络表 */
async function visualPayload(rows, { view = 'auto', cols = 2, cell = 560 } = {}) {
  if (view === 'none') return null;
  const usable = rows.filter((r) => r.path);
  if (!usable.length) return null;
  try {
    if (usable.length === 1 && view !== 'sheet') {
      const p = previewFor(usable[0].path, { maxSide: 1280 });
      return {
        content: [{ type: 'image', data: p.data, mimeType: p.mimeType }],
        note: `已附单图 ${usable[0].filename}，${usable[0].width}x${usable[0].height}，${p.mode}）`,
      };
    }
    const sheet = makeSheet(usable.map((r) => r.path), { cols, cell });
    const p = previewFor(sheet.out, { maxSide: 1600 });
    return {
      content: [{ type: 'image', data: p.data, mimeType: p.mimeType }],
      note: `已附联络表${sheet.out}，${sheet.count} 张，${sheet.width}x${sheet.height}）`,
    };
  } catch (e) {
    return { content: [], note: `生成预览失败：${e.message}` };
  }
}

// ---------------------------------------------------------------- server
const server = new McpServer(SERVER, { capabilities: { tools: {} } });

// ---------------------------------------------------------------- 活动日志
// 每个工具调用落一行 JSONL：谁、什么时候、跑了多久、成没成、返回了什么、附了几张图。
// 目的：让「我在干什么」对人是可见的——看板读这个文件，不用等我汇报（回应「黑箱」那条批评）。
const ACTIVITY = join(PROJECT_ROOT, '.memory', 'activity.jsonl');
function logActivity(rec) {
  try {
    mkdirSync(dirname(ACTIVITY), { recursive: true });
    appendFileSync(ACTIVITY, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n', 'utf8');
  } catch { /* 日志写不了不能影响主流程 */ }
}

// 用一层包装记录所有工具调用，避免每个 handler 里手写埋点（也避免漏写）
const _registerTool = server.tool.bind(server);
server.tool = (name, ...rest) => {
  const handler = rest[rest.length - 1];
  if (typeof handler !== 'function') return _registerTool(name, ...rest);
  const wrapped = async (...a) => {
    const t0 = Date.now();
    let r;
    try {
      r = await handler(...a);
    } catch (e) {
      logActivity({ tool: name, ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 300) });
      throw e;
    }
    const content = Array.isArray(r?.content) ? r.content : [];
    const txt = content.find((c) => c.type === 'text')?.text || '';
    logActivity({
      tool: name,
      ok: !r?.isError,
      ms: Date.now() - t0,
      images: content.filter((c) => c.type === 'image').length,
      brief: String(txt).replace(/\s+/g, ' ').slice(0, 200),
    });
    return r;
  };
  return _registerTool(name, ...rest.slice(0, -1), wrapped);
};


// ---- 工具块之间残留的 helper（原样保留）----



const submitShape = {
  template: z.string().optional().describe('模板名，如 flux_t2i（用 comfy_templates list 查看）'),
  workflow: z.record(z.any()).optional().describe('API 格式工作流{节点 id:{class_type,inputs}}；与 template 二选一'),
  params: z.record(z.any()).optional().describe('模板参数，如 {prompt:"...", width:1024, height:1024, seed:123}'),
};





// ---------------------------------------------------------------- 局部编辑（img2img / inpaint）
const EDIT_DIR = join(PROJECT_ROOT, '.memory', 'edits');

/**
 * 给任意图片工作流接上控制网：在末尾加三个节点（20 控制网、21 控制图、22 叠加），
 * 再把 KSampler 的正负条件改接到 22 的两个输出。comfy_edit 与 comfy_replace 共用这一份实现。
 */
function withControl(workflow, { controlName, strength = 0.75, net = 'flux-cn-union-pro-2.0.safetensors' } = {}) {
  const ksId = Object.keys(workflow).find((id) => workflow[id].class_type === 'KSampler');
  if (!ksId) throw new Error('工作流里没有 KSampler，无法接控制网');
  const vaeId = Object.keys(workflow).find((id) => workflow[id].class_type === 'VAELoader');
  const ks = workflow[ksId];
  return {
    ...workflow,
    20: { class_type: 'ControlNetLoader', inputs: { control_net_name: net } },
    21: { class_type: 'LoadImage', inputs: { image: controlName } },
    22: {
      class_type: 'ControlNetApplyAdvanced',
      inputs: {
        positive: ks.inputs.positive, negative: ks.inputs.negative,
        control_net: ['20', 0], image: ['21', 0],
        strength, start_percent: 0.0, end_percent: 1.0,
        ...(vaeId ? { vae: [vaeId, 0] } : {}),
      },
    },
    [ksId]: { ...ks, inputs: { ...ks.inputs, positive: ['22', 0], negative: ['22', 1] } },
  };
}

/** 拼一个「有蒙版就 inpaint、没蒙版就 img2img」的工作流（可选接控制网） */
function editWorkflow({
  imageName, maskName, prompt, negative = '', denoise = 1, steps = 20, guidance = 3.5,
  seed, prefix = 'comfyforge/edit', controlName = null, controlStrength = 0.75, controlNet,
}) {
  const params = {
    image: imageName, prompt, negative, denoise, steps, guidance,
    seed: seed ?? Math.floor(Math.random() * 2147483647), filename_prefix: prefix,
  };
  if (maskName) params.mask = maskName;
  const tplName = maskName ? 'flux_inpaint' : 'flux_img2img';
  const { workflow } = resolveTemplate(getTemplate(tplName), params);
  const wf = controlName ? withControl(workflow, { controlName, strength: controlStrength, net: controlNet || undefined }) : workflow;
  return { workflow: wf, params, tplName };
}

async function finishEdit(ctx, entry) {
  const parsed = parseHistoryEntry(entry);
  if (parsed.status !== 'success') {
    const diag = executionFailure(parsed);
    saveRun({ prompt_id: ctx.prompt_id, status: parsed.status, template: ctx.tpl, params: ctx.params, error: diag });
    return fail(`编辑失败：${diag.exception_message || parsed.status}`, { prompt_id: ctx.prompt_id, diagnosis: diag });
  }
  const { rows, metricError } = await inspectImages(parsed.images);
  let locality = null;
  if (ctx.mask && ctx.source && rows[0]?.path) {
    try { locality = diffImages({ a: ctx.source, b: rows[0].path, mask: ctx.mask }); }
    catch (e) { locality = { error: e.message }; }
  }
  saveRun({
    prompt_id: ctx.prompt_id, status: 'success', template: ctx.tpl, params: ctx.params,
    outputs: rows.map((r) => ({ filename: r.filename, subfolder: r.subfolder, path: r.path, quality: r.metrics ? trimMetrics(r.metrics) : null })),
  });
  const payload = {
    ok: true,
    prompt_id: ctx.prompt_id,
    template: ctx.tpl,
    params: ctx.params,
    source: ctx.source,
    mask: ctx.mask,
    box: ctx.box,
    outputs: rows.map((r) => ({
      filename: r.filename, subfolder: r.subfolder, path: r.path,
      width: r.width, height: r.height, bytes: r.bytes,
      quality: r.metrics ? trimMetrics(r.metrics) : null,
    })),
    locality,
    hint: locality && locality.changed_pct_outside_mask > 2
      ? '蒙版外改动偏大：把 denoise 降到 0.55~0.65，或缩小 box / 加大 feather。'
      : '改动基本落在蒙版内（蒙版外像素应几乎不变）。',
  };
  if (metricError) payload.metric_error = metricError;
  const visual = await visualPayload(rows, { view: 'auto' });
  const content = [{ type: 'text', text: J(payload) }];
  if (visual?.content?.length) content.push({ type: 'text', text: visual.note }, ...visual.content);
  return { content };
}
















// ---------------------------------------------------------------- 批量与挑图
async function pollMany(ids, deadline) {
  const entries = new Map();      // key = 调用方传入的 id
  const firstSeen = new Map();
  const unknown = [];
  while (Date.now() < deadline) {
    let q = null;
    let recent = null;
    for (const id of ids) {
      if (entries.has(id) || unknown.includes(id)) continue;
      // 一轮只拉一次最近历史（短 id 也能在里面做前缀匹配），避免每个 id 都打一次接口
      if (!recent) recent = await recentHistory(48);
      let entry = recent?.[id];
      if (!entry) {
        const hits = Object.keys(recent || {}).filter((k) => k.startsWith(id));
        if (hits.length === 1) entry = recent[hits[0]];
      }
      if (entry?.status?.status_str) { entries.set(id, entry); continue; }
      if (!q) q = await queueState();
      const inQueue = [...(q.queue_running || []), ...(q.queue_pending || [])].some((x) => String(x[1]).startsWith(id));
      if (inQueue) { firstSeen.delete(id); continue; }
      const t = firstSeen.get(id) ?? Date.now();
      firstSeen.set(id, t);
      if (Date.now() - t > NOT_QUEUED_GRACE_MS) unknown.push(id);
    }
    const finished = ids.filter((id) => entries.has(id) || unknown.includes(id)).length;
    if (finished >= ids.length) break;
    await sleep(POLL_MS);
  }
  return { entries, unknown };
}

async function summarizeEntries(entries, { inspect = true } = {}) {
  const rows = [];
  const jobs = [];
  for (const [id, entry] of entries) {
    const parsed = parseHistoryEntry(entry);
    const job = { prompt_id: id, status: parsed.status };
    if (parsed.status === 'success') {
      const r = inspect ? await inspectImages(parsed.images) : { rows: parsed.images.map((f) => ({ ...f, path: localOutputPath(f) })) };
      job.outputs = r.rows.map((x) => ({
        filename: x.filename, subfolder: x.subfolder, path: x.path, bytes: x.bytes,
        width: x.width, height: x.height,
        quality: x.metrics ? trimMetrics(x.metrics) : null,
      }));
      rows.push(...r.rows);
      // 提交时记下的「这批怎么来的」在这里补成正式运行记录
      const meta = takePending(id);
      saveRun({
        prompt_id: id, status: 'success',
        template: meta?.template, params: meta?.params || {},
        outputs: job.outputs,
      });
    } else {
      job.diagnosis = executionFailure(parsed);
    }
    jobs.push(job);
  }
  return { jobs, rows };
}









// ---------------------------------------------------------------- 工作流体检 + 视频
const inputDir = () => (COMFY_ROOT ? join(COMFY_ROOT, 'input') : null);

/** 视频路径：优先当本地绝对路径；否则按 output 里的 相对路径/filename+subfolder 解析 */
function resolveVideoPath(v) {
  if (!v) return null;
  if (existsSync(v)) return v;
  const norm2 = String(v).replace(/\\/g, '/');
  const sub = norm2.includes('/') ? norm2.slice(0, norm2.lastIndexOf('/')) : '';
  const p = localOutputPath({ filename: basename(norm2), subfolder: sub, type: 'output' });
  if (p) return p;
  const direct = OUTPUT_DIR ? join(OUTPUT_DIR, norm2) : null;
  return direct && existsSync(direct) ? direct : null;
}



// ---------------------------------------------------------------- prompt lint

// ---- 原本在文件尾部、但被工具块引用的 helper（不搬就是跨文件 ReferenceError）----
function newestOutputs(limit) {
  const exts = new Set(['.png', '.jpg', '.jpeg', '.webp']);
  const found = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      if (!exts.has(extname(name).toLowerCase())) continue;
      const rel = p.slice(OUTPUT_DIR.length + 1).replace(/\\/g, '/');
      const subfolder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      found.push({ path: p, mtime: st.mtimeMs, filename: name, subfolder });
    }
  };
  if (!OUTPUT_DIR) {
    throw new Error('不知道 ComfyUI 输出目录，无法「看最新几张」。设 COMFY_ROOT（含 main.py 的那层）或 COMFY_OUTPUT_DIR，或跑 node mcp/doctor.mjs 自查。');
  }
  walk(OUTPUT_DIR);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
    .map((f) => ({ filename: f.filename, subfolder: f.subfolder, type: 'output' }));
}

export { SERVER, J, text, fail, norm, gb, trimMetrics, inspectImages, resolveWorkflow, preflight, latentSize, queuePosition, executionFailure, viewHint, visualPayload, server, ACTIVITY, logActivity, _registerTool, submitShape, EDIT_DIR, withControl, editWorkflow, finishEdit, pollMany, summarizeEntries, inputDir, resolveVideoPath, newestOutputs };
