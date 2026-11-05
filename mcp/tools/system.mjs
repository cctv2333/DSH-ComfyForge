// tools/system.mjs —— system 域的工具注册（从 server.mjs 机械搬移，逻辑未改）
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
// 本文件注册 6 个工具：comfy_health, comfy_nodes, comfy_models, comfy_activity, comfy_profile, comfy_log

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
