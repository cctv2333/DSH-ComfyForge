// lib/journal.mjs — 工作日志与 bug 日志（写进工具里，而不是散落在聊天记录）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './comfy.mjs';

const DIR = join(PROJECT_ROOT, 'docs', 'journal');
const FILES = { work: join(DIR, 'WORKLOG.md'), bug: join(DIR, 'BUGLOG.md') };
const PREFIX = { work: 'WORK', bug: 'BUG' };

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 16);

function ensure(kind) {
  mkdirSync(DIR, { recursive: true });
  if (!existsSync(FILES[kind])) {
    const title = kind === 'work' ? '# 工作日志' : '# Bug 日志';
    writeFileSync(FILES[kind], `${title}\n\n> 由 comfy_journal 工具写入；每条带编号、时间、状态。\n\n`, 'utf8');
  }
}

function read(kind) {
  ensure(kind);
  return readFileSync(FILES[kind], 'utf8');
}

function nextId(kind) {
  const text = read(kind);
  const re = new RegExp(`${PREFIX[kind]}-(\\d{4})`, 'g');
  let max = 0, m;
  while ((m = re.exec(text))) max = Math.max(max, Number(m[1]));
  return `${PREFIX[kind]}-${String(max + 1).padStart(4, '0')}`;
}

export function append(kind, { title, body = '', tags = [], status = 'open', meta = {} }) {
  if (!FILES[kind]) throw new Error(`未知日志类型：${kind}`);
  if (!title) throw new Error('需要 title');
  ensure(kind);
  const id = nextId(kind);
  const tagLine = tags.length ? `\ntags: ${tags.join(', ')}` : '';
  const metaLine = Object.keys(meta).length ? `\nmeta: ${JSON.stringify(meta)}` : '';
  const block = `\n## ${id} · ${stamp()} · [${status}]\n\n**${title}**\n\n${body}${tagLine}${metaLine}\n`;
  writeFileSync(FILES[kind], read(kind) + block, 'utf8');
  return { id, file: FILES[kind], status };
}

export function list(kind, limit = 20) {
  const text = read(kind);
  const blocks = text.split(/\n## /).slice(1);
  return blocks.slice(-limit).map((b) => {
    const [head, ...rest] = b.split('\n');
    return { head: head.trim(), body: rest.join('\n').trim().slice(0, 400) };
  });
}

export function search(query, limit = 20) {
  const q = String(query).toLowerCase();
  const hits = [];
  for (const kind of ['work', 'bug']) {
    const blocks = read(kind).split(/\n## /).slice(1);
    for (const b of blocks) {
      if (b.toLowerCase().includes(q)) hits.push({ kind, head: b.split('\n')[0].trim(), body: b.split('\n').slice(1).join('\n').trim().slice(0, 300) });
    }
  }
  return hits.slice(-limit);
}

export function paths() { return FILES; }
