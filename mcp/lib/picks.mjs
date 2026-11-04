// lib/picks.mjs — 「我挑好的 / 你挑好的」共享清单（dashboard 与 MCP 工具读写同一份）
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './comfy.mjs';

const FILE = join(PROJECT_ROOT, 'picks.json');

export const keyOf = (filename, subfolder = '') => (subfolder ? `${subfolder}/${filename}` : filename);

export function readPicks() {
  if (!existsSync(FILE)) return { version: 1, items: {} };
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    return { version: 1, items: j.items || {} };
  } catch {
    return { version: 1, items: {} };
  }
}

function write(state) {
  writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
  return FILE;
}

export function addPick({ filename, subfolder = '', prompt_id, note = '', by = 'agent', quality }) {
  const state = readPicks();
  const key = keyOf(filename, subfolder);
  state.items[key] = {
    key, filename, subfolder, prompt_id, note, by,
    quality: quality || undefined,
    picked_at: new Date().toISOString(),
  };
  return { path: write(state), item: state.items[key] };
}

export function removePick(key) {
  const state = readPicks();
  const existed = !!state.items[key];
  delete state.items[key];
  return { path: write(state), removed: existed };
}

export function listPicks() {
  const state = readPicks();
  return { path: FILE, count: Object.keys(state.items).length, items: Object.values(state.items) };
}

export function clearPicks() {
  return { path: write({ version: 1, items: {} }), cleared: true };
}
