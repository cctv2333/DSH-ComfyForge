// lib/view.mjs — 看图的两档：整体（看气质/构图）与局部（看细节）
// 目的是控制上下文：整图先缩到能判断的大小，细节按需裁切，而不是每次塞原图。
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CACHE_DIR } from './comfy.mjs';
import { pythonPath } from './img.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PYSCRIPT = join(HERE, '..', 'scripts', 'imgops.py');

function runPy(args) {
  const r = spawnSync(pythonPath(), [PYSCRIPT, ...args], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  if (r.status !== 0) throw new Error(`imgops.py 失败：${(r.stderr || r.stdout || '').slice(-500)}`);
  const line = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  return JSON.parse(line);
}

/** 整体看：缩放 + 可选坐标网格（标签是原图坐标，方便直接写 box） */
export function lookAt(imagePath, { max = 900, grid = 0, out } = {}) {
  const target = out || join(CACHE_DIR, 'look', `${Date.now()}_${grid ? 'grid' : 'plain'}.jpg`);
  mkdirSync(dirname(target), { recursive: true });
  const args = ['look', '--in', imagePath, '--out', target, '--max', String(max)];
  if (grid > 0) args.push('--grid', String(grid));
  return { ...runPy(args), path: target };
}

/** 细节看：裁一块放大（坐标基于原图） */
export function regionOf(imagePath, box, { max = 900, out } = {}) {
  const target = out || join(CACHE_DIR, 'region', `${Date.now()}.jpg`);
  mkdirSync(dirname(target), { recursive: true });
  return { ...runPy(['region', '--in', imagePath, '--out', target, '--box', box.join(','), '--max', String(max)]), path: target };
}
