// lib/archive.mjs — 每一次工作的完整档案（不是日志，是可回放的工作记录）
//
// 回应的问题：「你只出结果，看不到你怎么排的、怎么试的；每次工作也没沉淀成经验」。
//
// 一条记录必须能回答四件事：
//   1. 为什么做（goal）
//   2. 具体怎么排（workflow：完整 API 图，可直接重跑）
//   3. 试了什么、结果如何（arms/params/outputs/metrics）
//   4. 学到什么（verdict + lesson），以及下次该改哪一条参数
//
// 存储：.memory/runs.jsonl（一行一条，append-only，可直接 grep；不搞向量库也能查）
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_ROOT } from './comfy.mjs';

const DIR = join(PROJECT_ROOT, '.memory');
const FILE = join(DIR, 'runs.jsonl');

function ensure() { if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true }); }

/** 生成一个可读的 id：日期-时间-类型 */
export function makeId(kind) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${kind}`;
}

/**
 * 记一次工作。
 * @param {object} rec
 * @param {string} rec.kind        类型：image-ab / video-2pass / sweep / lint …
 * @param {string} rec.goal        这次要回答的问题
 * @param {object} [rec.workflow]  完整 API 图（能直接重跑的）
 * @param {object} [rec.params]    关键参数
 * @param {Array}  [rec.arms]      对照分组 [{name, changes, outputs, metrics}]
 * @param {object} [rec.metrics]   汇总指标
 * @param {string} [rec.verdict]   结论
 * @param {string} [rec.lesson]    下次该改什么（一句话，可执行）
 * @param {string[]} [rec.tags]
 */
export function archive(rec) {
  ensure();
  const entry = {
    id: rec.id || makeId(rec.kind || 'work'),
    ts: new Date().toISOString(),
    kind: rec.kind || 'work',
    goal: rec.goal || '',
    params: rec.params || {},
    arms: rec.arms || [],
    metrics: rec.metrics || {},
    verdict: rec.verdict || '',
    lesson: rec.lesson || '',
    tags: rec.tags || [],
    workflow: rec.workflow || null,
    outputs: rec.outputs || [],
  };
  appendFileSync(FILE, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

export function loadAll() {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean).map((r) => {
    // 归一化：早期/外部写入的记录可能缺字段，直接打印会出字面量 undefined。
    // 这里补默认值，让 show / search / replay 都不必各自防御。
    if (!r.id) r.id = r.ts || r.runId || '(无id)';
    if (typeof r.goal !== 'string') r.goal = r.goal == null ? '' : String(r.goal);
    if (typeof r.verdict !== 'string') r.verdict = r.verdict == null ? '' : String(r.verdict);
    if (typeof r.lesson !== 'string') r.lesson = r.lesson == null ? '' : String(r.lesson);
    if (!Array.isArray(r.tags)) r.tags = [];
    return r;
  });
}

/** 关键词检索：goal / verdict / lesson / tags / kind 都参与 */
export function search(q) {
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return loadAll().filter((r) => re.test([r.kind, r.goal, r.verdict, r.lesson, ...(r.tags || [])].join(' ')));
}

export function get(id) {
  return loadAll().find((r) => r.id === id) || null;
}

/** 按类型统计：做了多少次、每次的结论是什么 */
export function stats() {
  const rows = loadAll();
  const byKind = {};
  for (const r of rows) {
    const k = r.kind || '(未分类/旧记录)';
    byKind[k] ||= { count: 0, ids: [] };
    byKind[k].count++;
    byKind[k].ids.push(r.id);
  }
  return { total: rows.length, byKind, file: FILE };
}

/** 把一条记录导出成可独立跑的脚本（放回 tools/experiments 就能重跑） */
export function exportScript(id, outPath) {
  const r = get(id);
  if (!r) throw new Error(`没有这条记录：${id}`);
  if (!r.workflow) throw new Error(`记录 ${id} 没有保存工作流图`);
  const body = `// 从工作档案重放：${r.id}
// 目标：${r.goal}
// 结论：${r.verdict}
// 教训：${r.lesson}
import { submit, waitFor, parseHistoryEntry } from '../../mcp/lib/comfy.mjs';

const wf = ${JSON.stringify(r.workflow, null, 2)};

const res = await submit(wf, { clientId: 'replay-${r.id}' });
console.log('queued', res.prompt_id);
for (;;) {
  const r = await waitFor(res.prompt_id, { timeoutS: 30 });
  if (r.pending) { process.stdout.write('.'); continue; }
  const p = parseHistoryEntry(r.entry);
  console.log('\\n', p.status, p.images?.map((i) => i.filename).join(', '));
  break;
}
`;
  writeFileSync(outPath, body, 'utf8');
  return outPath;
}
