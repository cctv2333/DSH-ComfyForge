// tools/library.mjs —— library 域的工具注册（从 server.mjs 机械搬移，逻辑未改）
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
// 本文件注册 6 个工具：comfy_workflows, comfy_journal, comfy_templates, comfy_runs, comfy_lessons, comfy_check_workflow

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
