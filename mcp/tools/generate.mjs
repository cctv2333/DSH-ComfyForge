// tools/generate.mjs —— generate 域的工具注册（从 server.mjs 机械搬移，逻辑未改）
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
// 本文件注册 6 个工具：comfy_run, comfy_wait, comfy_queue, comfy_sweep, comfy_batch, comfy_wait_many

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
