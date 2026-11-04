// lib/edit.mjs — 局部编辑的地基：上传图片、画蒙版、验证「改动是否真的局部」
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BASE, CACHE_DIR } from './comfy.mjs';
import { pythonPath } from './img.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PYSCRIPT = join(HERE, '..', 'scripts', 'imgops.py');

function runPy(args) {
  const r = spawnSync(pythonPath(), [PYSCRIPT, ...args], { encoding: 'utf8', timeout: 180_000, windowsHide: true });
  if (r.status !== 0) throw new Error(`imgops.py 失败：${(r.stderr || r.stdout || '').slice(-500)}`);
  const line = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  return JSON.parse(line);
}

/** 上传到 ComfyUI 的 input 目录，返回它认得的文件名 */
export async function uploadImage(localPath, { name, type = 'input', overwrite = true } = {}) {
  if (!existsSync(localPath)) throw new Error(`文件不存在：${localPath}`);
  const buf = readFileSync(localPath);
  const filename = name || `${Date.now()}_${basename(localPath)}`;
  const form = new FormData();
  const mime = extname(localPath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  form.append('image', new Blob([buf], { type: mime }), filename);
  form.append('type', type);
  form.append('overwrite', String(overwrite));
  const res = await fetch(`${BASE}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok || !json?.name) throw new Error(`上传失败 HTTP ${res.status}：${text.slice(0, 300)}`);
  return { name: json.name, subfolder: json.subfolder || '', type: json.type || type };
}

/** 生成蒙版（白=改，黑=不动），带羽化 */
export function makeMask({ imagePath, box, ellipse = false, expand = 8, feather = 12, out }) {
  const target = out || join(CACHE_DIR, 'masks', `mask_${Date.now()}.png`);
  mkdirSync(dirname(target), { recursive: true });
  const args = ['mask', '--in', imagePath, '--out', target, '--expand', String(expand), '--feather', String(feather)];
  if (box) args.push('--box', box.join(','));
  if (ellipse) args.push('--ellipse');
  const res = runPy(args);
  return { ...res, path: target };
}

/** 为「把物体放进场景」准备控制图与蒙版（场景边缘 + 物体边缘；蒙版保护电线/结构） */
export function placePrep({ scene, object, box, feather = 18, protect = 85 }) {
  const dir = join(CACHE_DIR, 'place');
  mkdirSync(dir, { recursive: true });
  const tag = `${Date.now()}`;
  const control = join(dir, `ctrl_${tag}.png`);
  const mask = join(dir, `mask_${tag}.png`);
  const res = runPy(['place', '--scene', scene, '--object', object, '--out-control', control, '--out-mask', mask,
    '--box', box.join(','), '--feather', String(feather), '--protect', String(protect)]);
  return { ...res, control, mask };
}

/** 照片 → ControlNet 边缘控制图（默认白底黑线；黑底白线会被模型当成线稿画风，见 BUG-0018） */
export function edgeControl({ scene, invert = true, thr = 0.15, out } = {}) {
  const dir = join(CACHE_DIR, 'ctrl');
  mkdirSync(dir, { recursive: true });
  const target = out || join(dir, `edges_${Date.now()}.png`);
  const args = ['edges', '--in', scene, '--out', target, '--thr', String(thr)];
  if (!invert) args.push('--no-invert');
  const res = runPy(args);
  return { ...res, path: target };
}

/** 按背景色抠出主体做蒙版（贴合物体，比矩形框接缝小）；可 place 到目标画布 / 限定 region */
export function keyMask({ image, out, tol = 22, expand = 8, feather = 20, place, canvas, region } = {}) {
  const dir = join(CACHE_DIR, 'masks');
  mkdirSync(dir, { recursive: true });
  const target = out || join(dir, `key_${Date.now()}.png`);
  const args = ['maskkey', '--in', image, '--out', target, '--tol', String(tol),
    '--expand', String(expand), '--feather', String(feather)];
  if (place && canvas) args.push('--place', place.join(','), '--canvas', canvas);
  if (region) args.push('--region', region.join(','));
  const res = runPy(args);
  return { ...res, path: target };
}

/** 两张蒙版取并集（旧物体 ∪ 新物体）：只有并集才能把旧轮廓一起擦掉（BUG-0021） */
export function unionMask({ a, b, out, expand = 10, feather = 24 } = {}) {
  const dir = join(CACHE_DIR, 'masks');
  mkdirSync(dir, { recursive: true });
  const target = out || join(dir, `union_${Date.now()}.png`);
  const res = runPy(['maskunion', '--a', a, '--b', b, '--out', target,
    '--expand', String(expand), '--feather', String(feather)]);
  return { ...res, path: target };
}

/** 把「参考渲染」贴进底图的指定区域（羽化接缝），用于分开渲染再合成 */
export function compositeImages({ base, patch, box, feather = 12, out }) {
  const target = out || join(CACHE_DIR, 'composite', `comp_${Date.now()}.png`);
  mkdirSync(dirname(target), { recursive: true });
  return { ...runPy(['composite', '--base', base, '--patch', patch, '--out', target, '--box', box.join(','), '--feather', String(feather)]), path: target };
}

/** 对比两张图：蒙版内应大改，蒙版外应几乎不动 */
export function diffImages({ a, b, mask, out }) {
  const target = out || join(CACHE_DIR, 'diffs', `diff_${Date.now()}.png`);
  mkdirSync(dirname(target), { recursive: true });
  const res = runPy(['diff', '--a', a, '--b', b, '--mask', mask, '--out', target]);
  return { ...res, path: target };
}
