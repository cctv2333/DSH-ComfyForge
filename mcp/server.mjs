#!/usr/bin/env node
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
} from './lib/comfy.mjs';
import { metrics as imgMetrics, makeSheet, materialize, previewFor } from './lib/img.mjs';
import {
  getTemplate, listTemplates, saveTemplate, deleteTemplate,
  resolveTemplate, validateWorkflow, saveRun, listRuns, ensureDirs,
} from './lib/templates.mjs';
import { readLog, lastTraceback, explainException } from './lib/diag.mjs';
import { rememberRun, rememberLesson, recallLessons, stats as memoryStats, setPending, takePending } from './lib/memory.mjs';
import { checkSize, modelFromWorkflow, listProfiles, profileFor, loadRegistry, saveRegistry } from './lib/models.mjs';
import { addPick, removePick, listPicks, clearPicks, keyOf } from './lib/picks.mjs';
import { uploadImage, makeMask, diffImages, compositeImages, placePrep, edgeControl, keyMask } from './lib/edit.mjs';
import { lookAt, regionOf } from './lib/view.mjs';
import { scan as triageScan, apply as triageApply, restore as triageRestore, resolveDir } from './lib/triage.mjs';
import { append as journalAppend, list as journalList, search as journalSearch, paths as journalPaths } from './lib/journal.mjs';
import { runChecks } from './lib/doctor.mjs';
import { auditModels } from './lib/modelfiles.mjs';
import {
  listWorkflows, inspectWorkflow, installedPacks, classifyNodes, renderWorkflowDoc, writeDoc, workflowDir,
} from './lib/workflows.mjs';
import { checkWorkflows, formatReport } from './lib/workflowcheck.mjs';
import { startVideo, videoStatus, framesFor, extractFrames, makeVideoSheet, videoMetrics } from './lib/video.mjs';
import { lintPrompt, lintWithLLM, readPromptFile } from './lib/promptlint.mjs';

const SERVER = { name: 'comfy-forge', version: '0.3.0' };

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

server.tool(
  'comfy_health',
  'ComfyUI 体检 + 环境自检：版本、GPU/显存、队列、日志最近报错，以及「配置从哪来、缺什么、怎么修」（ComfyUI 没启动也会返回这份清单）。开工前先跑这个。',
  {
    checks: z.boolean().default(true).describe('是否附带环境自检（配置来源 Python/模型/目录）'),
  },
  async (args) => {
    const env = args.checks === false ? null : await runChecks();
    let out;
    try {
      const [s, q] = await Promise.all([systemStats(), queueState()]);
      const d = s.devices?.[0] || {};
      out = {
        ok: env ? env.ok : true,
        url: BASE,
        mode: env?.mode,
        comfyui: s.system?.comfyui_version,
        python: s.system?.python_version,
        torch: s.system?.pytorch_version,
        gpu: d.name,
        vram_total: gb(d.vram_total || 0),
        vram_free: gb(d.vram_free || 0),
        ram_free: gb(s.system?.ram_free || 0),
        queue: { running: (q.queue_running || []).length, pending: (q.queue_pending || []).length },
        output_dir: OUTPUT_DIR,
      };
      if (Number(d.vram_free || 0) < 1.2e9) out.warning = '显存空闲 < 1.2GB，跑 1024 可能 OOM；考虑先重启 ComfyUI 或降到 768。';
      try {
        const log = readLog({ lines: 400 });
        out.log = { path: log.path, exists: log.exists, recent_error_lines: log.matched.length };
        out.last_error = lastTraceback()?.error_line || null;
      } catch (e) {
        out.log = { path: LOG_PATH, exists: false, error: e.message };
      }
    } catch (e) {
      // 连不上也给清单：分发给别人时，第一次跑就是这个场景，光说「连不上」没法修
      return fail(`连不上 ComfyUI：${e.message}`, {
        url: BASE,
        setup: env ? {
          mode: env.mode,
          summary: env.summary,
          checks: env.checks,
          config_file: env.config.config_file,
        } : undefined,
        hint: `确认 ComfyUI 已启动并监听 ${BASE}；如端口/机器不同，设 COMFY_URL。也可以直接跑 node mcp/doctor.mjs 看完整自检。`,
      });
    }
    if (env) {
      out.env = {
        mode: env.mode,
        summary: env.summary,
        checks: env.checks,
        paths: env.paths,
        // 「配置从哪来」：分发给别人后，报「值不对」时先看这里，别猜
        config: { config_file: env.config.config_file, fields: env.config.fields, missing: env.config.missing },
        // 能力清单：只说「有没有 / 缺什么 / 补它多大」，工具本身不装任何东西
        capabilities: env.capabilities ? {
          summary: env.capabilities.summary,
          have: env.capabilities.caps.filter((c) => c.ok === true).map((c) => c.title),
          missing: env.capabilities.caps.filter((c) => c.ok === false)
            .map((c) => ({ title: c.title, need: c.ifMissing, cost: c.cost })),
        } : undefined,
      };
      const bad = env.checks.filter((c) => c.level === 'fail');
      if (bad.length) out.hint = bad.map((c) => `${c.title}: ${c.fix || c.detail}`).join('；');
    }
    return text(out);
  },
);

server.tool(
  'comfy_nodes',
  '查节点：给 class_type 返回它的输入/输出定义；给 query 则按名字/类别搜本机可用节点。用来拼新工作流或排查「这个节点到底要什么」。',
  {
    class_type: z.string().optional().describe('精确节点名，如 KSampler'),
    query: z.string().optional().describe('模糊搜索，如 controlnet / upscale / lora'),
    limit: z.number().int().min(1).max(100).default(30),
  },
  async (args) => {
    try {
      const info = await objectInfo();
      if (args.class_type) {
        const def = info[args.class_type];
        if (!def) return fail(`本机没有节点 ${args.class_type}。用 query 搜一下。`);
        const shape = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, spec]) => [k, {
          type: Array.isArray(spec?.[0]) ? 'COMBO' : spec?.[0],
          options: Array.isArray(spec?.[0]) ? spec[0].slice(0, 12) : undefined,
          default: spec?.[1]?.default,
          min: spec?.[1]?.min, max: spec?.[1]?.max,
        }]));
        return text({
          ok: true, class_type: args.class_type, category: def.category,
          required: shape(def.input?.required), optional: shape(def.input?.optional),
          outputs: def.output, output_name: def.output_name,
        });
      }
      const q = String(args.query || '').toLowerCase();
      const hits = Object.entries(info)
        .filter(([name, def]) => !q || name.toLowerCase().includes(q) || String(def.category || '').toLowerCase().includes(q))
        .slice(0, args.limit)
        .map(([name, def]) => ({ class_type: name, category: def.category, outputs: def.output }));
      return text({ ok: true, query: q, total: hits.length, nodes: hits });
    } catch (e) {
      return fail(`查节点失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_models',
  '列出本机 ComfyUI 真正可见的模型：GGUF/UNET、checkpoint、VAE、文本编码器、LoRA、放大模型。只认文件，不认文档。刚放进新模型时用它强制刷新（会重新拉一次 object_info）。',
  {
    action: z.enum(['list', 'audit']).default('list').describe('list=有哪些模型；audit=检查文件放没放对目录（读文件头判断真实类型）'),
    refresh: z.boolean().default(true).describe('是否强制重新拉取（默认 true：刚加的模型马上能看到）'),
  },
  async (args) => {
    try {
      if (args.action === 'audit') {
        return text(auditModels());
      }
      const info = args.refresh === false ? await objectInfo() : await objectInfo({ maxAgeMs: 0 });
      const pick = (node, field) => info?.[node]?.input?.required?.[field]?.[0] || [];
      const out = {
        ok: true,
        unet_gguf: pick('UnetLoaderGGUF', 'unet_name'),
        unet: pick('UNETLoader', 'unet_name'),
        checkpoints: pick('CheckpointLoaderSimple', 'ckpt_name'),
        vae: pick('VAELoader', 'vae_name'),
        clip: pick('DualCLIPLoader', 'clip_name1'),
        loras: pick('LoraLoader', 'lora_name'),
        upscale: pick('UpscaleModelLoader', 'model_name'),
        controlnet: pick('ControlNetLoader', 'control_net_name'),
        profiles: (listProfiles().models || []).map((p) => ({
          file: p.file, usable: p.usable, family: p.family, native_mp: p.native_mp,
          buckets: p.buckets, note: p.note || p.reason,
        })),
      };
      return text(out);
    } catch (e) {
      return fail(`列模型失败：${e.message}`);
    }
  },
);

const submitShape = {
  template: z.string().optional().describe('模板名，如 flux_t2i（用 comfy_templates list 查看）'),
  workflow: z.record(z.any()).optional().describe('API 格式工作流{节点 id:{class_type,inputs}}；与 template 二选一'),
  params: z.record(z.any()).optional().describe('模板参数，如 {prompt:"...", width:1024, height:1024, seed:123}'),
};

server.tool(
  'comfy_run',
  '提交工作流并等一小段（默认 40s，最多 55s —— MCP 客户端单次调用约 60s 就超时，所以长任务靠这个循环等）。做静态校验 → 提交 → 等 → 取图 → 算客观指标，并把图或联络表附回来。没跑完会返回 pending + prompt_id，用 comfy_wait 继续等。validate_only=true 只校验不提交。',
  {
    ...submitShape,
    wait_s: z.number().int().min(0).max(55).default(40).describe('本次最多等几秒；=只提交'),
    validate_only: z.boolean().default(false).describe('只做静态校验，不提交'),
    inspect: z.boolean().default(true).describe('是否计算客观图像指标'),
    view: z.enum(['auto', 'none', 'sheet']).default('auto').describe('auto=单图给图、多图给联络表；none=不附图（省 token）'),
  },
  async (args) => {
    let resolved;
    try {
      resolved = await resolveWorkflow(args);
    } catch (e) {
      return fail(e.message);
    }
    const { workflow, applied, warnings, templateName } = resolved;
    let v;
    try {
      v = await preflight(workflow);
    } catch (e) {
      return fail(`校验阶段连不上 ComfyUI：${e.message}`);
    }
    const report = {
      warnings: [...warnings, ...v.warnings],
      hints: v.hints,
      nodes: Object.keys(workflow).length,
      model: v.size
        ? {
            file: v.size.profile.model,
            family: v.size.profile.family,
            native_mp: v.size.profile.native_mp,
            size: `${v.size.width}x${v.size.height}`,
            mp: Number(v.size.mp.toFixed(2)),
            exact_bucket: v.size.exact_bucket,
            usable: v.size.profile.usable,
          }
        : undefined,
    };
    if (v.errors.length) {
      return fail('工作流静态校验未通过（还没提交）', { ...report, errors: v.errors });
    }
    if (args.validate_only) {
      return text({ ok: true, validated: true, template: templateName, params: applied, ...report });
    }

    let sub;
    try {
      sub = await submit(workflow);
    } catch (e) {
      return fail(`提交失败：${e.message}`, { ...report, kind: e.kind, status: e.status });
    }
    const promptId = sub.prompt_id;
    if (args.wait_s <= 0) {
      const pos = await queuePosition(promptId);
      return text({ ok: true, pending: true, prompt_id: promptId, queued: pos, template: templateName, params: applied, ...report, next: 'comfy_wait(prompt_id) 等结果' });
    }

    let r;
    try {
      r = await waitFor(promptId, { timeoutS: args.wait_s });
    } catch (e) {
      return fail(e.message, { prompt_id: promptId, kind: e.kind, ...report });
    }
    if (r.pending) {
      return text({
        ok: true, pending: true, prompt_id: promptId,
        waited_s: Math.round(r.elapsedMs / 100) / 10, queue: r.queue,
        template: templateName, params: applied, ...report,
        next: `还没出图（1024x1024 约 60-90s）。再调一次。comfy_wait(prompt_id="${promptId}") 继续等。`,
      });
    }
    const entry = r.entry;
    const elapsedMs = r.elapsedMs;

    const parsed = parseHistoryEntry(entry);
    if (parsed.status !== 'success') {
      const diag = executionFailure(parsed);
      saveRun({ prompt_id: promptId, status: parsed.status, template: templateName, params: applied, workflow, error: diag });
      return fail(`执行失败：${diag.exception_message || parsed.status}`, { prompt_id: promptId, ...report, diagnosis: diag });
    }

    const { rows, metricError } = args.inspect
      ? await inspectImages(parsed.images)
      : { rows: parsed.images.map((f) => ({ ...f, path: localOutputPath(f) })), metricError: null };

    const payload = {
      ok: true,
      prompt_id: promptId,
      elapsed_s: Math.round(elapsedMs / 100) / 10,
      template: templateName,
      params: applied,
      outputs: rows.map((r) => ({
        filename: r.filename, subfolder: r.subfolder,
        path: r.path, bytes: r.bytes,
        width: r.width, height: r.height,
        quality: r.metrics ? trimMetrics(r.metrics) : null,
      })),
      ...report,
      next: '看附图（用 comfy_snapshot）判断质量；不满意就改 params 再跑。',
    };
    if (metricError) payload.metric_error = metricError;
    const vh = viewHint(rows);
    if (vh) payload.quality_flags = vh;

    saveRun({ prompt_id: promptId, status: 'success', template: templateName, params: applied, workflow, outputs: rows.map((r) => ({ filename: r.filename, subfolder: r.subfolder, path: r.path, quality: r.metrics ? trimMetrics(r.metrics) : null })) });
    rememberRun({ template: templateName, applied, workflow, promptId, elapsedMs, rows });

    const visual = await visualPayload(rows, { view: args.view });
    const content = [{ type: 'text', text: J(payload) }];
    if (visual?.content?.length) {
      content.push({ type: 'text', text: visual.note });
      content.push(...visual.content);
    }
    return { content };
  },
);

server.tool(
  'comfy_wait',
  '等一个已提交的 prompt_id（一次最多等 55s；没跑完返回 pending，再调一次即可）。完成时返回产物清单与客观指标。',
  {
    prompt_id: z.string(),
    wait_s: z.number().int().min(5).max(55).default(40),
    inspect: z.boolean().default(true),
    view: z.enum(['auto', 'none', 'sheet']).default('none'),
  },
  async (args) => {
    let r;
    try {
      r = await waitFor(args.prompt_id, { timeoutS: args.wait_s });
    } catch (e) {
      return fail(e.message, { prompt_id: args.prompt_id, kind: e.kind });
    }
    if (r.pending) {
      return text({ ok: true, pending: true, prompt_id: args.prompt_id, waited_s: Math.round(r.elapsedMs / 100) / 10, queue: r.queue, next: '再调用一次 comfy_wait 继续。' });
    }
    const entry = r.entry;
    const elapsedMs = r.elapsedMs;
    const parsed = parseHistoryEntry(entry);
    if (parsed.status !== 'success') {
      const diag = executionFailure(parsed);
      return fail(`执行失败：${diag.exception_message || parsed.status}`, { prompt_id: args.prompt_id, diagnosis: diag });
    }
    const { rows, metricError } = args.inspect
      ? await inspectImages(parsed.images)
      : { rows: parsed.images.map((f) => ({ ...f, path: localOutputPath(f) })), metricError: null };
    const payload = {
      ok: true,
      prompt_id: args.prompt_id,
      waited_s: Math.round(elapsedMs / 100) / 10,
      outputs: rows.map((r) => ({
        filename: r.filename, subfolder: r.subfolder, path: r.path, bytes: r.bytes,
        width: r.width, height: r.height,
        quality: r.metrics ? trimMetrics(r.metrics) : null,
      })),
    };
    if (metricError) payload.metric_error = metricError;
    const visual = await visualPayload(rows, { view: args.view });
    const content = [{ type: 'text', text: J(payload) }];
    if (visual?.content?.length) content.push({ type: 'text', text: visual.note }, ...visual.content);
    return { content };
  },
);

server.tool(
  'comfy_queue',
  '队列：status 看排队运行中；cancel 取消指定 prompt_id；clear 清空待跑队列。',
  {
    action: z.enum(['status', 'cancel', 'clear']).default('status'),
    prompt_id: z.string().optional(),
  },
  async (args) => {
    try {
      if (args.action === 'status') {
        const q = await queueState();
        const brief = (item) => ({
          prompt_id: item[1],
          nodes: Object.keys(item[2] || {}).length,
          class_types: [...new Set(Object.values(item[2] || {}).map((n) => n.class_type))].slice(0, 6),
        });
        return text({ ok: true, running: (q.queue_running || []).map(brief), pending: (q.queue_pending || []).map(brief) });
      }
      if (args.action === 'cancel') {
        if (!args.prompt_id) return fail('cancel 需要 prompt_id');
        const q = await queueState();
        const isRunning = (q.queue_running || []).some((x) => x[1] === args.prompt_id);
        await deleteFromQueue([args.prompt_id]);
        if (isRunning) await interrupt();
        takePending(args.prompt_id); // 取消的任务不在 pending 垃圾
        return text({ ok: true, cancelled: args.prompt_id, was_running: isRunning });
      }
      const q = await queueState();
      const ids = (q.queue_pending || []).map((x) => x[1]);
      if (!ids.length) return text({ ok: true, cleared: 0 });
      await deleteFromQueue(ids);
      return text({ ok: true, cleared: ids.length, ids });
    } catch (e) {
      return fail(`队列操作失败：${e.message}`);
    }
  },
);

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

server.tool(
  'comfy_upload',
  '把本地图片上传到 ComfyUI 的 input 目录，返回 LoadImage 能用的文件名。img2img / inpaint 前需要它。',
  {
    path: z.string().describe('本地图片绝对路径'),
    type: z.enum(['input', 'temp']).default('input'),
  },
  async (args) => {
    try {
      const up = await uploadImage(args.path, { type: args.type });
      return text({ ok: true, ...up, local: args.path });
    } catch (e) {
      return fail(`上传失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_edit',
  '局部编辑：给一张图 + 一个矩形/椭圆区域，只重画那块（蒙版外几乎不动）；不给 box 就是整图低 denoise 精修。返回产物和「蒙版内外改动比例」，用来验证是否真的只改了局部。',
  {
    image: z.string().optional().describe('本地图片绝对路径（自动上传），或 input 目录里的文件名；续等时可不传'),
    box: z.array(z.number()).length(4).optional().describe('[x, y, w, h]；给了就是局部重绘，不给就是整图 img2img'),
    mask: z.string().optional().describe('显式蒙版图路径（白色=重画）。比矩形 box 更贴合物体，接缝更小；与 box 二选一'),
    ellipse: z.boolean().default(false).describe('蒙版用椭圆而不是圆角矩形'),
    expand: z.number().int().min(0).max(200).default(10).describe('蒙版向外扩几像素'),
    feather: z.number().int().min(0).max(80).default(14).describe('羽化半径，越大接缝越软'),
    prompt: z.string().optional().describe('只描述「蒙版里应该出现什么」，不要重复整幅画面'),
    negative: z.string().default(''),
    denoise: z.number().min(0.05).max(1).optional().describe('局部 0.65~0.8；整图精修 0.25~0.45；有 control 时用 0.9~1.0'),
    control: z.string().optional().describe('控制图路径（如 C-130 线稿/深度图）。提示词说不清的形状，靠它定；不给就纯提示词'),
    control_strength: z.number().min(0).max(2).default(0.75).describe('控制强度；>0.9 容易复刻画风'),
    control_net: z.string().default('flux-cn-union-pro-2.0.safetensors'),
    steps: z.number().int().min(4).max(60).default(20),
    seed: z.number().int().optional(),
    guidance: z.number().min(0).max(10).default(3.5),
    wait_s: z.number().int().min(0).max(55).default(45),
    prompt_id: z.string().optional().describe('续等上一次编辑（返回 pending 时用。'),
  },
  async (args) => {
    try {
      let ctx;
      if (args.prompt_id) {
        const p = join(EDIT_DIR, `${args.prompt_id}.json`);
        if (!existsSync(p)) return fail(`找不到${args.prompt_id} 的编辑上下文，可能已被清理`);
        ctx = JSON.parse(readFileSync(p, 'utf8'));
      } else {
        if (!args.image) return fail('需要 image（本地绝对路径，或 input 目录里的文件名）');
        if (!args.prompt) return fail('需要 prompt（描述蒙版里应该出现什么）');
        const localSrc = existsSync(args.image)
          ? args.image
          : (COMFY_ROOT ? join(COMFY_ROOT, 'input', args.image) : args.image);
        if (!existsSync(localSrc)) {
          return fail(`找不到图片：${args.image}` + (COMFY_ROOT ? `（也查过 ${join(COMFY_ROOT, 'input')}）`
            : '（remote 模式只认本地绝对路径；没配置 COMFY_ROOT，无法在其 input 目录里找）'));
        }
        const up = await uploadImage(localSrc, { name: `src_${Date.now()}${extname(localSrc) || '.png'}` });

        let mask = null;
        let maskName = null;
        if (args.mask) {
          // 显式蒙版：只重画蒙版里那部分（比矩形框更贴合物体，接缝也小）
          if (!existsSync(args.mask)) return fail(`找不到蒙版：${args.mask}`);
          mask = { path: args.mask };
          const upm = await uploadImage(args.mask, { name: `mask_${Date.now()}.png` });
          maskName = upm.name;
        } else if (args.box) {
          mask = makeMask({
            imagePath: localSrc, box: args.box, ellipse: args.ellipse,
            expand: args.expand, feather: args.feather,
          });
          const upm = await uploadImage(mask.path, { name: `mask_${Date.now()}.png` });
          maskName = upm.name;
        }

        const isInpaint = !!(maskName);
        const tplName = isInpaint ? 'flux_inpaint' : 'flux_img2img';
        const params = {
          image: up.name,
          prompt: args.prompt,
          negative: args.negative,
          denoise: args.denoise ?? (isInpaint ? (args.control ? 0.9 : 0.7) : 0.4),
          steps: args.steps,
          guidance: args.guidance,
          seed: args.seed ?? Math.floor(Math.random() * 2147483647),
          filename_prefix: `comfyforge/${isInpaint ? 'inpaint' : 'img2img'}`,
        };
        if (maskName) params.mask = maskName;

        const tpl = getTemplate(tplName);
        const { workflow: baseWf } = resolveTemplate(tpl, params);
        let workflow = baseWf;

        // 可选控制网：提示词说不清「这是哪种飞机/哪个人/什么姿势」时，用控制图定形状。
        // 做法是在模板末尾接三个节点（20 控制网、21 控制图、22 叠加），再把 KSampler 的 cond 改接到 22。
        let controlInfo = null;
        if (args.control) {
          if (!existsSync(args.control)) return fail(`找不到控制图：${args.control}`);
          const upctrl = await uploadImage(args.control, { name: `ctrl_${Date.now()}.png` });
          workflow = withControl(workflow, { controlName: upctrl.name, strength: args.control_strength, net: args.control_net });
          controlInfo = { path: args.control, strength: args.control_strength, net: args.control_net };
        }

        const v = await preflight(workflow);
        if (v.errors.length) return fail('编辑工作流没通过校验', { errors: v.errors, warnings: v.warnings, hints: v.hints });

        const sub = await submit(workflow);
        ctx = {
          prompt_id: sub.prompt_id, tpl: tplName, params,
          source: localSrc, mask: mask?.path || null, box: args.box || null,
          control: controlInfo,
          created: new Date().toISOString(),
        };
        mkdirSync(EDIT_DIR, { recursive: true });
        writeFileSync(join(EDIT_DIR, `${sub.prompt_id}.json`), JSON.stringify(ctx, null, 2), 'utf8');
      }

      const r = await waitFor(ctx.prompt_id, { timeoutS: args.wait_s });
      if (r.pending) {
        return text({
          ok: true, pending: true, prompt_id: ctx.prompt_id,
          waited_s: Math.round(r.elapsedMs / 100) / 10, queue: r.queue,
          mask: ctx.mask, source: ctx.source,
          next: `还没跑完：comfy_edit(prompt_id="${ctx.prompt_id}") 继续`,
        });
      }
      return await finishEdit(ctx, r.entry);
    } catch (e) {
      return fail(`局部编辑失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_replace',
  '换物体（先擦后画两遍法）：把 box 里的旧东西擦成背景，再用控制图把新物体画进去。适合「把 A 换成 B，其它别动」。比单次 inpaint 稳，因为第一遍不要求画面里有什么。',
  {
    image: z.string().optional().describe('底图本地路径（续等时可不传）'),
    box: z.array(z.number()).length(4).optional().describe('要替换的区域 [x,y,w,h]（第一遍擦除就在这块里）'),
    object: z.string().optional().describe('新物体的参考图（控制图画它，不给就只用提示词）'),
    prompt: z.string().optional().describe('第二遍：描述新物体应该在画面里长什么样'),
    erase_prompt: z.string().default('seamless continuation of the surrounding background, exactly the same brightness, color and texture, no objects'),
    control_strength: z.number().min(0).max(2).default(0.75),
    steps: z.number().int().min(4).max(60).default(20),
    feather: z.number().int().min(0).max(80).default(30).describe('区域的羽化半径；小蒙版会让模型不理会提示词，所以默认给足'),
    wait_s: z.number().int().min(0).max(55).default(50),
    prompt_id: z.string().optional().describe('续等（两遍法要跑两次，返回 pending 时用）'),
  },
  async (args) => {
    try {
      let ctx;
      if (args.prompt_id) {
        const p = join(EDIT_DIR, `${args.prompt_id}.json`);
        if (!existsSync(p)) return fail(`找不到 ${args.prompt_id} 的替换上下文`);
        ctx = JSON.parse(readFileSync(p, 'utf8'));
      } else {
        if (!args.image || !args.box || !args.prompt) return fail('需要 image、box、prompt（续等时只传 prompt_id）');
        const src = existsSync(args.image) ? args.image : (COMFY_ROOT ? join(COMFY_ROOT, 'input', args.image) : args.image);
        if (!existsSync(src)) return fail(`找不到底图：${args.image}`);

        const size = imgMetrics([src])[0];
        const W = size?.width, H = size?.height;
        if (!W || !H) return fail('量不出底图尺寸，无法生成蒙版');

        // 第一遍的蒙版：整块区域（不是物体轮廓——贴着轮廓的蒙版会让模型顺着旧线继续画）
        const eraseMask = makeMask({ imagePath: src, box: args.box, expand: 20, feather: args.feather });
        const upSrc = await uploadImage(src, { name: `replace_src_${Date.now()}${extname(src) || '.png'}` });
        const upMask = await uploadImage(eraseMask.path, { name: `replace_mask_${Date.now()}.png` });

        // 第二遍要用的东西先准备好：控制图 + 蒙版。
        // 蒙版用「区域」而不是物体轮廓：贴着轮廓的蒙版会让模型顺着旧线画（BUG-0022 的实测结论）
        let controlPath = null;
        if (args.object) {
          if (!existsSync(args.object)) return fail(`找不到参考图：${args.object}`);
          controlPath = placePrep({ scene: src, object: args.object, box: args.box, feather: 0, protect: 0 }).control;
        }
        const drawMask = eraseMask.path;

        const { workflow, params, tplName } = editWorkflow({
          imageName: upSrc.name, maskName: upMask.name, prompt: args.erase_prompt,
          denoise: 1.0, steps: args.steps, prefix: 'comfyforge/replace_erase',
        });
        const v = await preflight(workflow);
        if (v.errors.length) return fail('擦除这一步没通过校验', { errors: v.errors, warnings: v.warnings, hints: v.hints });
        const sub = await submit(workflow);
        ctx = {
          prompt_id: sub.prompt_id, stage: 'erase', tpl: tplName, params,
          source: src, box: args.box, object: args.object || null,
          prompt: args.prompt, controlPath, drawMask,
          control_strength: args.control_strength, steps: args.steps,
          created: new Date().toISOString(),
        };
        mkdirSync(EDIT_DIR, { recursive: true });
        writeFileSync(join(EDIT_DIR, `${sub.prompt_id}.json`), JSON.stringify(ctx, null, 2), 'utf8');
        // 第一遍刚提交就返回：两遍生成加起来必然超过客户端 60s 上限，不能在同一次调用里连等
        return text({
          ok: true, pending: true, stage: 'erase', prompt_id: sub.prompt_id,
          next: `comfy_replace(prompt_id="${sub.prompt_id}") 继续（等擦除完成，随后自动画新物体）`,
        });
      }
      {
        const r = await waitFor(ctx.prompt_id, { timeoutS: args.wait_s });
        if (r.pending) {
          return text({
            ok: true, pending: true, stage: ctx.stage, prompt_id: ctx.prompt_id, queue: r.queue,
            next: `comfy_replace(prompt_id="${ctx.prompt_id}") 继续`,
          });
        }
        const parsed = parseHistoryEntry(r.entry);
        if (parsed.status !== 'success') {
          const diag = executionFailure(parsed);
          return fail(`替换失败（${ctx.stage} 阶段）：${diag.exception_message || parsed.status}`, { stage: ctx.stage, diagnosis: diag });
        }

        if (ctx.stage === 'erase') {
          const { rows } = await inspectImages(parsed.images);
          const cleaned = rows.find((x) => x.path)?.path;
          if (!cleaned) return fail('擦除这一步没有产物');
          const up2 = await uploadImage(cleaned, { name: `replace_clean_${Date.now()}.png` });
          const upMask2 = await uploadImage(ctx.drawMask, { name: `replace_mask2_${Date.now()}.png` });
          let upCtrl = null;
          if (ctx.controlPath) upCtrl = await uploadImage(ctx.controlPath, { name: `replace_ctrl_${Date.now()}.png` });

          const draw = editWorkflow({
            imageName: up2.name, maskName: upMask2.name, prompt: ctx.prompt,
            denoise: 1.0, steps: ctx.steps, prefix: 'comfyforge/replace_draw',
            controlName: upCtrl?.name || null, controlStrength: ctx.control_strength,
          });
          const v2 = await preflight(draw.workflow);
          if (v2.errors.length) return fail('画物体这一步没通过校验', { errors: v2.errors, warnings: v2.warnings, hints: v2.hints });
          const sub2 = await submit(draw.workflow);
          ctx = {
            ...ctx, stage: 'draw', prompt_id: sub2.prompt_id,
            params: draw.params, tpl: draw.tplName, erased: cleaned,
          };
          writeFileSync(join(EDIT_DIR, `${sub2.prompt_id}.json`), JSON.stringify(ctx, null, 2), 'utf8');
          return text({
            ok: true, pending: true, stage: 'draw', prompt_id: sub2.prompt_id, erased: cleaned,
            next: `comfy_replace(prompt_id="${sub2.prompt_id}") 继续（等新物体画完）`,
          });
        }

        // stage = draw：出结果
        const { rows } = await inspectImages(parsed.images);
        const payload = {
          ok: true, stage: 'done', prompt_id: ctx.prompt_id,
          source: ctx.source, erased: ctx.erased, box: ctx.box,
          control: ctx.controlPath, prompt: ctx.prompt,
          outputs: rows.map((x) => ({ path: x.path, quality: x.metrics ? trimMetrics(x.metrics) : null })),
          note: '两遍法：第一遍把区域擦成背景，第二遍用控制图画新物体。若新物体没有出现，先看 control 是否为 null（没给参考图就是纯提示词）。',
        };
        saveRun({
          prompt_id: ctx.prompt_id, status: 'success', template: 'comfy_replace', params: ctx.params,
          outputs: rows.map((x) => ({ path: x.path, quality: x.metrics ? trimMetrics(x.metrics) : null })),
        });
        const visual = await visualPayload(rows, { view: 'auto' });
        const content = [{ type: 'text', text: J(payload) }];
        if (visual?.content?.length) content.push({ type: 'text', text: visual.note }, ...visual.content);
        return { content };
      }
    } catch (e) {
      return fail(`替换失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_workflows',
  '看法 ComfyUI 里保存的工作流（别人怎么做的）：列出目录、拆出用了哪些节点/模型/输入文件、判断本机缺哪些插件，并可写出 Markdown 说明。只读，不改文件。',
  {
    action: z.enum(['list', 'inspect', 'doc', 'packs']).default('list').describe('list=列出；inspect=拆解；doc=拆解并写 markdown 到 docs/workflows/；packs=本机已装插件及仓库地址'),
    name: z.string().optional().describe('工作流名（不带 .json）'),
    path: z.string().optional().describe('或直接给 .json 路径'),
  },
  async (args) => {
    try {
      if (args.action === 'packs') {
        const packs = installedPacks();
        return text({ ok: true, dir: COMFY_ROOT ? join(COMFY_ROOT, 'custom_nodes') : null, count: packs.length, packs });
      }
      if (args.action === 'list') {
        return text({ ok: true, dir: workflowDir(), workflows: listWorkflows() });
      }
      let target = args.path;
      if (!target) {
        if (!args.name) return fail('需要 name（工作流名）或 path（.json 路径）');
        const hit = listWorkflows().find((w) => w.name === args.name || w.name.toLowerCase() === args.name.toLowerCase());
        if (!hit) return fail(`找不到工作流 ${args.name}。用 action="list" 看看有哪些。`);
        target = hit.path;
      }
      if (!existsSync(target)) return fail(`文件不存在：${target}`);
      const info = inspectWorkflow(target);
      let objectInfo = null;
      try { objectInfo = await get('/object_info', 90_000); } catch { /* ComfyUI 没连上也能拆解，只是判不了缺 */ }
      const classified = classifyNodes(info.nodes, objectInfo);
      const missing = classified.filter((c) => c.origin === 'missing').map((c) => c.class_type);
      if (args.action === 'inspect') {
        return text({
          ok: true, path: target, format: info.format,
          nodes: classified, models: info.models, inputs: info.inputs,
          missing_plugins: missing,
          hint: missing.length
            ? '缺的节点类不在本机 object_info 里：要么装对应插件，要么用 action="doc" 生成一份需求说明发给作者/去 Manager registry 查归属。'
            : '本机节点齐全，可以直接试跑。',
        });
      }
      const md = renderWorkflowDoc(info, { classified, packHints: installedPacks() });
      const saved = writeDoc(args.name || info.path.split(/[\\/]/).pop(), md);
      return text({ ok: true, path: target, doc: saved, missing_plugins: missing, markdown: md });
    } catch (e) {
      return fail(`读工作流失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_sweep',
  '分辨率试错：同一 seed、同一提示词跑一组尺寸，按客观指标排序，帮你找这个模型「最佳分辨率」。社区的二次训练 checkpoint 各家原生分辨率都不一样，别信硬编码的 1024。',
  {
    template: z.string().optional().describe('模板名（如 sd15_t2i / flux_t2i）'),
    params: z.record(z.any()).optional().describe('基础参数（prompt/steps 等），尺寸由 sweep 覆盖'),
    sizes: z.array(z.string()).optional().describe('候选尺寸 ["512x768","768x512",...]，最多 8 个；不给就用模型推荐桶'),
    seed: z.number().int().optional().describe('固定 seed，只让分辨率变（默认随机一个，整组共用）'),
    wait_s: z.number().int().min(0).max(55).default(45),
    prompt_id: z.string().optional().describe('续等（返回 pending 后用它继续）'),
  },
  async (args) => {
    try {
      let ctx;
      if (args.prompt_id) {
        const p = join(EDIT_DIR, `${args.prompt_id}.json`);
        if (!existsSync(p)) return fail(`找不到 ${args.prompt_id} 的 sweep 记录`);
        ctx = JSON.parse(readFileSync(p, 'utf8'));
      } else {
        if (!args.template) return fail('需要 template（用 comfy_templates 查看）');
        const tpl = getTemplate(args.template);
        const modelFile = tpl.model;
        const prof = profileFor(modelFile);
        const baseParams = { ...(args.params || {}) };
        const seed = args.seed ?? Math.floor(Math.random() * 2147483647);

        // 没给尺寸就用模型档案里的推荐桶；一个都没有才退回 512/768 这类通用猜测
        let sizes = args.sizes;
        if (!sizes?.length) {
          sizes = (prof?.buckets || []).map(([w, h]) => `${w}x${h}`);
          if (!sizes.length) sizes = ['512x512', '512x768', '768x512'];
        }
        sizes = sizes.slice(0, 8);
        const parsed = sizes.map((s) => {
          const m = String(s).match(/^(\d+)x(\d+)$/);
          if (!m) throw new Error(`尺寸写法不对：${s}（要 512x768 这样）`);
          return { label: s, width: Number(m[1]), height: Number(m[2]) };
        });

        const jobs = [];
        for (const s of parsed) {
          const params = { ...baseParams, width: s.width, height: s.height, seed };
          const { workflow, params: applied } = resolveTemplate(tpl, params);
          const v = validateWorkflow(workflow, await objectInfo());
          if (v.errors.length) return fail(`${s.label} 校验没过：${v.errors.join('；')}`);
          const sub = await submit(workflow);
          jobs.push({ prompt_id: sub.prompt_id, size: s.label, mp: (s.width * s.height) / 1e6, params: applied });
        }
        ctx = {
          kind: 'sweep', template: args.template, model: modelFile, family: prof?.family || 'unknown',
          seed, sizes: parsed.map((p) => p.label), jobs,
          buckets: (prof?.buckets || []).map((b) => b.join('x')),
          created: new Date().toISOString(),
        };
        mkdirSync(EDIT_DIR, { recursive: true });
        writeFileSync(join(EDIT_DIR, `${jobs[0].prompt_id}.json`), JSON.stringify(ctx, null, 2), 'utf8');
        return text({
          ok: true, pending: true, submitted: jobs.length, seed, sizes: ctx.sizes,
          first_prompt_id: jobs[0].prompt_id,
          next: `comfy_sweep(prompt_id="${jobs[0].prompt_id}") 继续收集结果`,
        });
      }

      // 收集：在 wait_s 预算内反复查（不能只查一次就返回，否则外部要空转很多轮）
      const t0 = Date.now();
      const budget = (args.wait_s ?? 45) * 1000;
      let pending = [];
      let images = [];
      for (;;) {
        pending = [];
        images = [];
        for (const job of ctx.jobs) {
          const { entry } = await historyResolved(job.prompt_id);
          const st = entry?.status?.status_str;
          if (!st) { pending.push({ size: job.size, status: 'running' }); continue; }
          if (st !== 'success') { pending.push({ size: job.size, status: st }); continue; }
          for (const img of parseHistoryEntry(entry).images) images.push({ ...img, size: job.size });
        }
        if (!pending.length) break;
        if (Date.now() - t0 > budget) break;
        await sleep(POLL_MS);
      }
      if (pending.length) {
        return text({
          ok: true, pending: true, done: ctx.jobs.length - pending.length, total: ctx.jobs.length,
          waiting: pending, prompt_id: ctx.jobs[0].prompt_id, waited_s: Math.round((Date.now() - t0) / 100) / 10,
          next: `还有 ${pending.length} 张没好，继续 comfy_sweep(prompt_id="${ctx.jobs[0].prompt_id}")`,
        });
      }

      const { rows } = await inspectImages(images);
      const table = rows.filter((r) => r.metrics).map((r) => ({
        size: r.size,
        mp: +r.metrics.megapixels.toFixed(2),
        lap_var_512: r.metrics.lap_var_512,
        edge_pct: r.metrics.edge_pct,
        contrast: r.metrics.contrast,
        clip_high: r.metrics.clip_high,
        verdict: r.metrics.verdict.level,
        flags: r.metrics.verdict.flags,
        path: r.path,
      }));
      // 排序规则：先剔除高光严重溢出的（>12%），再按 512 归一化锐度排序。
      // 注意不能用 imgops 的 verdict：它的 below_native 是相对「约 1MP」模型定的，SD1.5 在 512 本来就该报这个。
      const clean = table.filter((t) => t.clip_high <= 0.12);
      const pool = clean.length ? clean : table;
      pool.sort((a, b) => b.lap_var_512 - a.lap_var_512);
      const best = pool[0] || null;
      const inBucket = best ? ctx.buckets.includes(best.size) : false;

      const payload = {
        ok: true, kind: 'sweep', template: ctx.template, model: ctx.model, family: ctx.family,
        seed: ctx.seed, buckets: ctx.buckets,
        rule: '剔除高光溢出 >12% 的，再按 lap_var_512（统一缩到 512 后测的锐度，跨分辨率可比）排序。'
          + '这张表只回答「哪个分辨率细节最多」，不回答「哪个最好看」——最终要亲眼看（指标高≠画面好，实测过）。',
        table,
        best: best ? { size: best.size, lap_var_512: best.lap_var_512, in_bucket: inBucket } : null,
        advice: best
          ? (inBucket ? `建议用 ${best.size}（在推荐桶内，锐度最高）。` : `${best.size} 锐度最高，但不在推荐桶 ${ctx.buckets.join('/')} 里——先看图确认有没有重复肢体/构图失衡再定。`)
          : '没有可用结果',
        next: best ? `想固定下来：comfy_profile(action="set", model="${ctx.model}", profile={"buckets":[["${best.size.split('x')[0]}","${best.size.split('x')[1]}"]]})` : undefined,
      };
      saveRun({
        prompt_id: ctx.jobs[0].prompt_id, status: 'success', template: ctx.template,
        params: { sweep: ctx.sizes, seed: ctx.seed, model: ctx.model }, outputs: table,
      });
      const visual = await visualPayload(rows, { view: 'sheet', cols: Math.min(3, table.length || 1) });
      const content = [{ type: 'text', text: J(payload) }];
      if (visual?.content?.length) content.push({ type: 'text', text: visual.note }, ...visual.content);
      return { content };
    } catch (e) {
      return fail(`sweep 失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_activity',
  '看「我刚才做了什么」：最近 N 次工具调用（时间、耗时、成败、返回摘要、附了几张图）。给人看的，也方便我事后复盘。',
  {
    limit: z.number().int().min(1).max(200).default(20),
  },
  async (args) => {
    try {
      if (!existsSync(ACTIVITY)) return text({ ok: true, count: 0, items: [], note: '还没有活动记录（重启后才会开始记）' });
      const lines = readFileSync(ACTIVITY, 'utf8').trim().split('\n').filter(Boolean);
      const items = lines.slice(-args.limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return text({ ok: true, file: ACTIVITY, count: items.length, items });
    } catch (e) {
      return fail(`读活动日志失败：${e.message}`);
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
  '淘汰/清理：只按客观缺陷（读不出/ 近似纯色 / 死糊 / 过小 / 重复）判定，不做审美判断；执行时移到 _trash/ 并写 manifest，不删除；picks 里的图永不移动；可 restore 一键恢复。',
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
  'comfy_composite',
  '合成：把一张「参考渲染」按 box 贴进底图（羽化接缝）。用于「分开渲染再合成」的参考图工作流 —— 例如单独渲染一架 C-130，再贴进街景。',
  {
    base: z.string().describe('底图路径'),
    patch: z.string().describe('要贴进去的图路径'),
    box: z.array(z.number()).length(4).describe('[x, y, w, h]：贴到底图的位置与尺寸'),
    feather: z.number().int().min(0).max(80).default(12),
  },
  async (args) => {
    try {
      if (!existsSync(args.base) || !existsSync(args.patch)) return fail('底图或贴图不存在');
      const r = compositeImages({ base: args.base, patch: args.patch, box: args.box, feather: args.feather });
      const p = previewFor(r.path, { maxSide: 1280 });
      return {
        content: [
          { type: 'text', text: J({ ok: true, out: r.out, box: r.box, feather: r.feather }) },
          { type: 'image', data: p.data, mimeType: p.mimeType },
        ],
      };
    } catch (e) {
      return fail(`合成失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_place',
  '把物体放进场景（修「贴纸感」）：自动生成「场景边缘 + 物体边缘」控制图与「保护电线结构」蒙版，供 ControlNet + 局部重绘。box 指定位置与大小。',
  {
    scene: z.string().optional().describe('底图本地路径（续等时可不传）'),
    object: z.string().optional().describe('物体图（参考渲染）本地路径'),
    box: z.array(z.number()).length(4).optional().describe('[x,y,w,h]'),
    prompt: z.string().optional(),
    denoise: z.number().min(0.2).max(1).default(0.85),
    strength: z.number().min(0).max(2).default(0.9),
    feather: z.number().int().min(0).max(80).default(18),
    protect: z.number().int().min(0).max(100).default(85).describe('保护场景结构的强度（电线/建筑边缘不被擦掉。'),
    steps: z.number().int().min(4).max(60).default(20),
    wait_s: z.number().int().min(0).max(55).default(45),
    prompt_id: z.string().optional(),
  },
  async (args) => {
    try {
      let ctx;
      if (args.prompt_id) {
        const p = join(EDIT_DIR, `${args.prompt_id}.json`);
        if (!existsSync(p)) return fail(`找不到${args.prompt_id} 的放置上下文`);
        ctx = JSON.parse(readFileSync(p, 'utf8'));
      } else {
        if (!args.scene || !args.object || !args.box || !args.prompt) return fail('需要 scene / object / box / prompt');
        const prep = placePrep({ scene: args.scene, object: args.object, box: args.box, feather: args.feather, protect: args.protect });
        const upS = await uploadImage(args.scene, { name: `place_src_${Date.now()}.png` });
        const upC = await uploadImage(prep.control, { name: `place_ctrl_${Date.now()}.png` });
        const upM = await uploadImage(prep.mask, { name: `place_mask_${Date.now()}.png` });
        const wf = {
          1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux1-dev-Q4_K_S.gguf' } },
          2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl_fp16.safetensors', type: 'flux' } },
          3: { class_type: 'VAELoader', inputs: { vae_name: 'flux-ae.safetensors' } },
          4: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: args.prompt } },
          5: { class_type: 'FluxGuidance', inputs: { conditioning: ['4', 0], guidance: 3.5 } },
          6: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: '' } },
          7: { class_type: 'LoadImage', inputs: { image: upS.name } },
          8: { class_type: 'LoadImageMask', inputs: { image: upM.name, channel: 'red' } },
          9: { class_type: 'VAEEncode', inputs: { pixels: ['7', 0], vae: ['3', 0] } },
          10: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['9', 0], mask: ['8', 0] } },
          11: { class_type: 'LoadImage', inputs: { image: upC.name } },
          12: { class_type: 'ControlNetLoader', inputs: { control_net_name: 'flux-cn-union-pro-2.0.safetensors' } },
          13: { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['5', 0], negative: ['6', 0], control_net: ['12', 0], image: ['11', 0], strength: args.strength, start_percent: 0.0, end_percent: 1.0, vae: ['3', 0] } },
          14: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['13', 0], negative: ['13', 1], latent_image: ['10', 0], seed: Math.floor(Math.random() * 2147483647), steps: args.steps, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: args.denoise } },
          15: { class_type: 'VAEDecode', inputs: { samples: ['14', 0], vae: ['3', 0] } },
          16: { class_type: 'SaveImage', inputs: { images: ['15', 0], filename_prefix: 'comfyforge/place' } },
        };
        const v = await preflight(wf);
        if (v.errors.length) return fail('放置工作流没通过校验', { errors: v.errors, warnings: v.warnings });
        const sub = await submit(wf);
        ctx = {
          prompt_id: sub.prompt_id, tpl: 'comfy_place',
          params: { prompt: args.prompt, box: args.box, denoise: args.denoise, strength: args.strength, protect: args.protect },
          source: args.scene, mask: prep.mask, control: prep.control, box: args.box,
        };
        mkdirSync(EDIT_DIR, { recursive: true });
        writeFileSync(join(EDIT_DIR, `${sub.prompt_id}.json`), JSON.stringify(ctx, null, 2), 'utf8');
      }

      const r = await waitFor(ctx.prompt_id, { timeoutS: args.wait_s });
      if (r.pending) {
        return text({ ok: true, pending: true, prompt_id: ctx.prompt_id, next: `comfy_place(prompt_id="${ctx.prompt_id}")` });
      }
      return await finishEdit(ctx, r.entry);
    } catch (e) {
      return fail(`放置失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_restructure',
  '全局重构（当局部重绘反复失败时用）：用「场景边缘+ 物体边缘」当构图草图，从空 latent 整张重画，让光照/透视从一开始就一致，而不是把物体贴上去。',
  {
    scene: z.string().optional().describe('构图参考：底图本地路径（续等时可不传）'),
    object: z.string().optional().describe('要放进构图的新物体图；不给就只按底图结构重画'),
    box: z.array(z.number()).length(4).optional().describe('物体在图里的位置 [x,y,w,h]；给了 object 才需要'),
    prompt: z.string().optional().describe('整张画面的描述'),
    steps: z.number().int().min(4).max(60).default(24),
    strength: z.number().min(0).max(2).default(0.65).describe('控制强度。>0.8 会把控制图的线当成画面内容（蓝图风，BUG-0018）'),
    control: z.enum(['edges', 'invert_edges', 'raw']).default('edges').describe('控制图来源：edges=照片转白底黑线（默认）；invert_edges=黑底白线；raw=直接用原图'),
    size: z.string().optional().describe('输出尺寸，如 "1024x1024"；不给就按控制图长宽比推（16 的倍数）'),
    guidance: z.number().min(0).max(10).default(3.5),
    wait_s: z.number().int().min(0).max(55).default(45),
    prompt_id: z.string().optional(),
  },
  async (args) => {
    try {
      let ctx;
      if (args.prompt_id) {
        const p = join(EDIT_DIR, `${args.prompt_id}.json`);
        if (!existsSync(p)) return fail(`找不到${args.prompt_id} 的重构上下文`);
        ctx = JSON.parse(readFileSync(p, 'utf8'));
      } else {
        if (!args.scene || !args.prompt) return fail('需要 scene 与 prompt（续等时只传 prompt_id）');
        let control;
        if (args.object && args.box) {
          control = placePrep({ scene: args.scene, object: args.object, box: args.box, feather: 0, protect: 0 }).control;
        } else if (args.control === 'raw') {
          control = args.scene;
        } else {
          // 只按底图结构重画：先把照片转成边缘图（白底黑线），而不是把整张照片当控制图
          control = edgeControl({ scene: args.scene, invert: args.control !== 'invert_edges' }).path;
        }
        // 输出尺寸跟控制图长宽比走，别一律正方形（否则透视被压扁）
        let width = 1024, height = 1024;
        if (args.size && /^\d+x\d+$/.test(args.size)) {
          [width, height] = args.size.split('x').map(Number);
        } else {
          try {
            const cm = imgMetrics([control])[0];
            const r16 = (n) => Math.max(256, Math.round(n / 16) * 16);
            if (cm?.width && cm?.height) {
              width = r16(cm.width);
              height = r16(cm.height);
            }
          } catch { /* 量不出就用 1024 方图 */ }
        }
        const upC = await uploadImage(control, { name: `restruct_ctrl_${Date.now()}.png` });
        const wf = {
          1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux1-dev-Q4_K_S.gguf' } },
          2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl_fp16.safetensors', type: 'flux' } },
          3: { class_type: 'VAELoader', inputs: { vae_name: 'flux-ae.safetensors' } },
          4: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: args.prompt } },
          5: { class_type: 'FluxGuidance', inputs: { conditioning: ['4', 0], guidance: args.guidance } },
          6: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: '' } },
          7: { class_type: 'LoadImage', inputs: { image: upC.name } },
          8: { class_type: 'ControlNetLoader', inputs: { control_net_name: 'flux-cn-union-pro-2.0.safetensors' } },
          9: { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['5', 0], negative: ['6', 0], control_net: ['8', 0], image: ['7', 0], strength: args.strength, start_percent: 0.0, end_percent: 1.0, vae: ['3', 0] } },
          10: { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: 1 } },
          11: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['9', 0], negative: ['9', 1], latent_image: ['10', 0], seed: Math.floor(Math.random() * 2147483647), steps: args.steps, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0 } },
          12: { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
          13: { class_type: 'SaveImage', inputs: { images: ['12', 0], filename_prefix: 'comfyforge/restructure' } },
        };
        const v = await preflight(wf);
        if (v.errors.length) return fail('重构工作流没通过校验', { errors: v.errors, warnings: v.warnings });
        const sub = await submit(wf);
        ctx = {
          prompt_id: sub.prompt_id, tpl: 'comfy_restructure',
          params: { prompt: args.prompt, strength: args.strength, control: args.control, size: `${width}x${height}`, box: args.box },
          source: args.scene, control_path: control,
        };
        mkdirSync(EDIT_DIR, { recursive: true });
        writeFileSync(join(EDIT_DIR, `${sub.prompt_id}.json`), JSON.stringify(ctx, null, 2), 'utf8');
      }
      const r = await waitFor(ctx.prompt_id, { timeoutS: args.wait_s });
      if (r.pending) return text({ ok: true, pending: true, prompt_id: ctx.prompt_id, next: `comfy_restructure(prompt_id="${ctx.prompt_id}")` });
      const parsed = parseHistoryEntry(r.entry);
      if (parsed.status !== 'success') {
        const diag = executionFailure(parsed);
        return fail(`重构失败：${diag.exception_message || parsed.status}`, { diagnosis: diag });
      }
      const { rows } = await inspectImages(parsed.images);
      const payload = {
        ok: true, prompt_id: ctx.prompt_id, template: ctx.tpl, params: ctx.params,
        outputs: rows.map((x) => ({ filename: x.filename, subfolder: x.subfolder, path: x.path, quality: x.metrics ? trimMetrics(x.metrics) : null })),
        note: '全局重构：整张重画，物体与场景的光照/透视为同一次采样产生。',
      };
      const visual = await visualPayload(rows, { view: 'auto' });
      const content = [{ type: 'text', text: J(payload) }];
      if (visual?.content?.length) content.push({ type: 'text', text: visual.note }, ...visual.content);
      return { content };
    } catch (e) {
      return fail(`重构失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_journal',
  '工作日志 / Bug 日志：把「做了什么、踩了什么坑、怎么修的」写进工具自己的文档（docs/journal/WORKLOG.md、BUGLOG.md），可 list / search，bug 可标 open/fixed。',
  {
    action: z.enum(['work', 'bug', 'list', 'search']).default('list'),
    title: z.string().optional().describe('work/bug 时必填：一句话标题'),
    body: z.string().default('').describe('细节：现象、原因、改法、证据'),
    tags: z.array(z.string()).default([]),
    status: z.enum(['open', 'fixed', 'wontfix']).default('open'),
    query: z.string().default(''),
    limit: z.number().int().min(1).max(100).default(20),
  },
  async (args) => {
    try {
      if (args.action === 'list') {
        return text({ ok: true, files: journalPaths(), work: journalList('work', args.limit), bug: journalList('bug', args.limit) });
      }
      if (args.action === 'search') {
        return text({ ok: true, query: args.query, hits: journalSearch(args.query, args.limit) });
      }
      if (!args.title) return fail(`${args.action} 需要 title`);
      const r = journalAppend(args.action, { title: args.title, body: args.body, tags: args.tags, status: args.status });
      return text({ ok: true, ...r });
    } catch (e) {
      return fail(`写日志失败：${e.message}`);
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

server.tool(
  'comfy_batch',
  '一次生成多张（多 seed）：同一个模板+ 一组 seed，全部提交后等一小段，返回每张的 seed/状态质量，并把已完成的拼成一张联络表。没跑完的用 comfy_wait_many 继续。',
  {
    template: z.string().describe('模板名'),
    params: z.record(z.any()).optional().describe('公共参数（prompt/width/height/steps...）'),
    seeds: z.array(z.number().int()).min(1).max(8).optional().describe('seed 列表；不传则用 params.seed 或随机 4 个'),
    wait_s: z.number().int().min(0).max(55).default(50),
    view: z.enum(['auto', 'none', 'sheet']).default('sheet'),
    cols: z.number().int().min(1).max(4).default(2),
  },
  async (args) => {
    const base = { ...(args.params || {}) };
    const seeds = args.seeds?.length
      ? args.seeds
      : [base.seed ?? Math.floor(Math.random() * 2147483647)];
    try {
      // 先校验一次（同一模板，尺寸模型问题一次性暴露）
      const first = await resolveWorkflow({ template: args.template, params: { ...base, seed: seeds[0] } });
      const pre = await preflight(first.workflow);
      if (pre.errors.length) return fail('批量任务在提交前就被拦下', { errors: pre.errors, warnings: [...first.warnings, ...pre.warnings], hints: pre.hints });
      const info = await objectInfo();
      void info;

      const submitted = [];
      for (const seed of seeds) {
        const r = resolveTemplate(getTemplate(args.template), { ...base, seed });
        const s = await submit(r.workflow);
        submitted.push({ seed, prompt_id: s.prompt_id });
        // 长批次常常要跨多次调用才完成，先把「这批怎么来的」存下来
        setPending(s.prompt_id, { template: args.template, params: { ...base, seed }, at: new Date().toISOString() });
      }
      const ids = submitted.map((s) => s.prompt_id);
      let done = new Map();
      let unknown = [];
      let pollError = null;
      if (args.wait_s > 0) {
        // 关键：已经提交的 id 绝不能丢 —— 轮询失败也要把 batch 返给调用方，否则任务成了孤儿
        try {
          const r = await pollMany(ids, Date.now() + args.wait_s * 1000);
          done = r.entries;
          unknown = r.unknown;
        } catch (e) {
          pollError = e.message;
        }
      }
      const { jobs, rows } = await summarizeEntries(done);
      const byId = new Map(jobs.map((j) => [j.prompt_id, j]));
      const batch = submitted.map((s) => byId.get(s.prompt_id) || { seed: s.seed, prompt_id: s.prompt_id, status: 'running' });
      const remaining = submitted.filter((s) => !done.has(s.prompt_id) && !unknown.includes(s.prompt_id)).map((s) => s.prompt_id);
      const payload = {
        ok: true, template: args.template, params: base, seeds, count: seeds.length,
        batch, remaining, unknown_ids: unknown.length ? unknown : undefined,
        poll_error: pollError || undefined,
        next: remaining.length ? `还有 ${remaining.length} 张在跑：comfy_wait_many(prompt_ids=[...])` : '全部完成',
        preview_warnings: [...first.warnings, ...pre.warnings],
        hints: pre.hints,
      };
      const visual = await visualPayload(rows, { view: args.view, cols: args.cols });
      const content = [{ type: 'text', text: J(payload) }];
      if (visual?.content?.length) content.push({ type: 'text', text: visual.note }, ...visual.content);
      return { content };
    } catch (e) {
      return fail(`批量提交失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_wait_many',
  '同时等多个 prompt_id（一次最多 55s），返回已完成仍在跑，并把已完成的拼成联络表。',
  {
    prompt_ids: z.array(z.string()).min(1).max(12),
    wait_s: z.number().int().min(5).max(55).default(45),
    view: z.enum(['auto', 'none', 'sheet']).default('sheet'),
    cols: z.number().int().min(1).max(4).default(2),
  },
  async (args) => {
    try {
      const { entries: done, unknown } = await pollMany(args.prompt_ids, Date.now() + args.wait_s * 1000);
      const { jobs, rows } = await summarizeEntries(done);
      const remaining = args.prompt_ids.filter((id) => !done.has(id) && !unknown.includes(id));
      const visual = await visualPayload(rows, { view: args.view, cols: args.cols });
      const content = [{
        type: 'text',
        text: J({ ok: true, done: jobs.length, jobs, remaining, unknown_ids: unknown.length ? unknown : undefined, next: remaining.length ? '再调一次 comfy_wait_many' : '全部完成' }),
      }];
      if (visual?.content?.length) content.push({ type: 'text', text: visual.note }, ...visual.content);
      return { content };
    } catch (e) {
      return fail(`等待失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_profile',
  '模型档案：list 列出所有模型的原生分辨率宽高比桶/可用性；get 看单个；set 登记或修改（family/label/usable/reason/note）。分辨率校验就是按这份档案做的。',
  {
    action: z.enum(['list', 'get', 'set']).default('list'),
    model: z.string().optional(),
    profile: z.record(z.any()).optional().describe('set 时的字段：${family,label,usable,reason,note}'),
  },
  async (args) => {
    try {
      if (args.action === 'list') return text({ ok: true, ...listProfiles() });
      if (!args.model) return fail('需要 model（模型文件名）');
      if (args.action === 'get') return text({ ok: true, profile: profileFor(args.model), size_hint: profileFor(args.model).buckets });
      const reg = loadRegistry({ fresh: true });
      reg.models = reg.models || {};
      reg.models[args.model] = { ...(reg.models[args.model] || {}), ...(args.profile || {}) };
      const saved = saveRegistry(reg);
      return text({ ok: true, saved: saved.path, profile: profileFor(args.model) });
    } catch (e) {
      return fail(`模型档案操作失败：${e.message}`);
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

server.tool(
  'comfy_templates',
  '工作流模板库：list 列出 / get 取全文/ save 保存 / delete 删除。模板是纯 JSON（workflow + bindings + defaults），存在 workflows/ 目录，可直接手改。',
  {
    action: z.enum(['list', 'get', 'save', 'delete']).default('list'),
    name: z.string().optional(),
    template: z.record(z.any()).optional().describe('save 时传：${title, description, model, bindings, defaults, workflow}'),
  },
  async (args) => {
    try {
      ensureDirs();
      if (args.action === 'list') return text({ ok: true, dir: WORKFLOW_DIR, templates: listTemplates() });
      if (!args.name) return fail(`${args.action} 需要 name`);
      if (args.action === 'get') return text({ ok: true, dir: WORKFLOW_DIR, template: getTemplate(args.name) });
      if (args.action === 'delete') return text({ ok: true, ...deleteTemplate(args.name) });
      if (!args.template) return fail('save 需要 template 对象');
      return text({ ok: true, ...saveTemplate(args.name, args.template) });
    } catch (e) {
      return fail(`模板操作失败：${e.message}`, { dir: WORKFLOW_DIR });
    }
  },
);

server.tool(
  'comfy_runs',
  '最近的运行记录（每次生成都落盘到 runs/，含工作流、参数、产物、质量判定），可用于回看与复制成模板。',
  { limit: z.number().int().min(1).max(50).default(10) },
  async (args) => {
    try {
      return text({ ok: true, dir: RUNS_DIR, runs: listRuns(args.limit) });
    } catch (e) {
      return fail(`读运行记录失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_lessons',
  '本地经验库：remember 记一条「参数 → 结果」的经验或踩过的坑；recall 按关键词/标签取回；stats 看积累量。跨会话有效，存在.memory/lessons.jsonl。',
  {
    action: z.enum(['remember', 'recall', 'stats']).default('recall'),
    text: z.string().optional().describe('remember 时必填'),
    tags: z.array(z.string()).default([]),
    query: z.string().default(''),
    limit: z.number().int().min(1).max(50).default(10),
  },
  async (args) => {
    try {
      if (args.action === 'remember') {
        if (!args.text) return fail('remember 需要 text');
        return text({ ...rememberLesson(args.text, args.tags), stats: memoryStats() });
      }
      if (args.action === 'stats') return text({ ok: true, ...memoryStats() });
      return text({ ok: true, lessons: recallLessons({ query: args.query, tags: args.tags, limit: args.limit }), stats: memoryStats() });
    } catch (e) {
      return fail(`经验库操作失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_log',
  'ComfyUI 日志：默认给尾部；errors_only=true 只看报错行；同时抽取最后一段 Python Traceback 并给建议。',
  {
    lines: z.number().int().min(20).max(1000).default(120),
    errors_only: z.boolean().default(false),
  },
  async (args) => {
    try {
      const log = readLog({ lines: args.lines, errorsOnly: args.errors_only });
      const tb = lastTraceback();
      return text({
        ok: true, path: log.path, exists: log.exists,
        error_lines: log.matched.slice(-20),
        traceback: tb,
        hints: tb?.error_line ? explainException(tb.error_line) : [],
        text: log.text,
      });
    } catch (e) {
      return fail(`读日志失败：${e.message}`);
    }
  },
);

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

server.tool(
  'comfy_check_workflow',
  '体检工作流缺件：拿 /object_info 与本机 custom_nodes 比对，把缺失节点分成三档——A 已装未加载（重启即可）/ B 未安装（给仓库地址）/ C 来源未知。只读，不装任何东西。',
  {
    path: z.string().optional().describe('工作流 JSON 路径，也可以是目录（会扫里面所有 .json）'),
    json: z.string().optional().describe('直接给工作流 JSON 文本（与 path 二选一）'),
    detail: z.boolean().optional().describe('true = 返回结构化 JSON，默认返回人读文本'),
  },
  async ({ path: p, json, detail = false }) => {
    let tmp = null;
    try {
      let targets;
      if (json) {
        tmp = join(tmpdir(), `comfyforge-wf-${Date.now()}.json`);
        writeFileSync(tmp, json, 'utf8');
        targets = [tmp];
      } else if (p) {
        if (!existsSync(p)) return fail(`找不到工作流文件：${p}`);
        targets = [p];
      } else {
        return fail('需要 path 或 json 之一');
      }
      const res = await checkWorkflows(targets);
      return text({
        ok: res.totalMissing === 0,
        knownTypes: res.knownTypes,
        totalMissing: res.totalMissing,
        summary: formatReport(res),
        ...(detail ? { report: res.report } : {}),
      });
    } catch (e) {
      return fail(e.message, { hint: e.kind === 'connect' ? '先确认 ComfyUI 在跑（comfy_health）' : undefined });
    } finally {
      if (tmp) { try { unlinkSync(tmp); } catch { /* ignore */ } }
    }
  },
);

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

// ---------------------------------------------------------------- prompt lint
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

// ---------------------------------------------------------------- misc
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

// 启动横幅（走 stderr，不污染 stdio 的 JSON-RPC）：
// 分发给别人以后，「配置没对」要在客户端日志里就能看见，不必先撞一次失败。
try {
  const { describe } = await import('./lib/config.mjs');
  const d = describe();
  const notes = [];
  if (d.config_file.error) notes.push(`配置文件有问题：${d.config_file.error}`);
  if (d.mode === 'remote') notes.push('未找到 ComfyUI 安装目录 → remote 模式（只走 HTTP，读不到日志/本地原图）。设 COMFY_ROOT 可切换。');
  for (const name of d.missing) {
    if (name === 'outputDir' || name === 'comfyRoot') notes.push(`缺配置${name}（看最新图/淘汰/看板会不可用）`);
  }
  if (notes.length) {
    process.stderr.write(`[comfy-forge] 环境提示：\n  - ${notes.join('\n  - ')}\n 自查：node mcp/doctor.mjs\n`);
  }
} catch (e) {
  process.stderr.write(`[comfy-forge] 配置自检失败（不影响启动）：${e.message}\n`);
}

const transport = new StdioServerTransport();
await server.connect(transport);

// 不让未捕获异常静默杀死服务：打到 stderr，客户端仍能拿到错误响应
process.on('unhandledRejection', (e) => {
  process.stderr.write(`[comfy-forge] unhandledRejection: ${e?.stack || e}\n`);
});
process.on('uncaughtException', (e) => {
  process.stderr.write(`[comfy-forge] uncaughtException: ${e?.stack || e}\n`);
});
