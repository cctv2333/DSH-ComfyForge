// lib/memory.mjs — 本地经验库：什么参数出什么结果、踩过什么坑
// 纯 JSONL，人可读可改；给 agent 一个「跨会话记得住」的地方。
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './comfy.mjs';

const DIR = join(PROJECT_ROOT, '.memory');
const RUNS = join(DIR, 'runs.jsonl');
const LESSONS = join(DIR, 'lessons.jsonl');

function ensure() { mkdirSync(DIR, { recursive: true }); }
function append(file, obj) { ensure(); appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8'); }
function readAll(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

export function rememberRun({ template, applied, workflow, promptId, elapsedMs, rows }) {
  try {
    const quality = rows.map((r) => ({
      filename: r.filename, w: r.width, h: r.height,
      lap512: r.metrics?.lap_var_512, level: r.metrics?.verdict?.level, flags: r.metrics?.verdict?.flags,
    }));
    append(RUNS, {
      at: new Date().toISOString(), prompt_id: promptId, template,
      params: applied, elapsed_s: Math.round(elapsedMs / 100) / 10,
      nodes: Object.keys(workflow || {}).length, quality,
    });
  } catch { /* 记不住不影响出图 */ }
}

export function rememberLesson(text, tags = []) {
  append(LESSONS, { at: new Date().toISOString(), text: String(text), tags: tags.map(String) });
  return { ok: true, path: LESSONS };
}

export function recallLessons({ query = '', tags = [], limit = 10 } = {}) {
  const q = String(query).toLowerCase();
  const all = readAll(LESSONS);
  const hits = all.filter((l) => {
    const tagOk = !tags.length || tags.some((t) => (l.tags || []).includes(t));
    const textOk = !q || (l.text || '').toLowerCase().includes(q) || (l.tags || []).join(',').toLowerCase().includes(q);
    return tagOk && textOk;
  });
  return hits.slice(-limit).reverse();
}

export function recallRuns(limit = 10) {
  return readAll(RUNS).slice(-limit).reverse();
}

export function stats() {
  return { lessons: readAll(LESSONS).length, runs: readAll(RUNS).length, dir: DIR };
}

// —— 提交与完成可能隔着多次调用：先把「这批是怎么来的」记在 pending，完成时再落正式记录 ——
const PENDING = join(DIR, 'pending');

export function setPending(promptId, meta) {
  ensure();
  mkdirSync(PENDING, { recursive: true });
  writeFileSafe(join(PENDING, `${promptId}.json`), JSON.stringify(meta));
}

export function takePending(promptId) {
  const p = join(PENDING, `${promptId}.json`);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    rmSync(p, { force: true });
    return j;
  } catch {
    return null;
  }
}

function writeFileSafe(p, s) {
  try { writeFileSync(p, s, 'utf8'); } catch { /* 记不住不影响出图 */ }
}
