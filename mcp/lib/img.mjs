// lib/img.mjs — 图像度量 / 拼图 / 缩略图：调本地 Python(Pillow+numpy)，不联网
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_DIR, viewBytes, localOutputPath } from './comfy.mjs';
import { PYTHON } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'imgops.py');

// 候选顺序：配置解析出的 python（env / 配置文件 / ComfyUI 便携包自带）→ PATH 里的通用名。
// 不用绝对路径写死任何一台机器——分发包在别人机器上找不到 python 时，报错文本会告诉他怎么设。
const PY_CANDIDATES = [PYTHON, 'python', 'python3', 'py'].filter(Boolean);

let _py = null;
export function pythonPath() {
  if (_py) return _py;
  for (const p of PY_CANDIDATES) {
    if (p.includes('\\') || p.includes('/')) {
      if (existsSync(p)) { _py = p; return p; }
      continue;
    }
    const r = spawnSync(p, ['-c', 'import PIL,numpy'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    if (r.status === 0) { _py = p; return p; }
  }
  throw new Error(
    '找不到可用的 Python（需要 Pillow + numpy）。修法：设环境变量 COMFYFORGE_PY 指向 python.exe，' +
    '或在 comfyforge.config.json 里写 {"python": "C:/Python312/python.exe"}；ComfyUI 便携包自带的 python 通常已装好依赖。' +
    '运行 node mcp/doctor.mjs 可看已探测到哪些候选。',
  );
}

/** 实测一个 python 能不能干活（doctor / comfy_health 用），不抛异常 */
export function probePython(exe = null) {
  const target = exe || _py || PY_CANDIDATES[0];
  if (!target) return { ok: false, exe: null, error: '没有候选 python' };
  const r = spawnSync(target, ['-c', 'import sys,PIL,numpy;print(sys.version.split()[0])'],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  if (r.error) return { ok: false, exe: target, error: r.error.message };
  if (r.status !== 0) {
    return { ok: false, exe: target, error: ((r.stderr || '') + (r.stdout || '')).trim().slice(-300) || `退出码 ${r.status}` };
  }
  return { ok: true, exe: target, version: (r.stdout || '').trim() };
}

function runPy(args, { timeout = 180_000 } = {}) {
  const r = spawnSync(pythonPath(), [SCRIPT, ...args], {
    encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  if (r.error) throw new Error(`运行 imgops.py 失败：${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`imgops.py 退出码 ${r.status}：${(r.stderr || r.stdout || '').slice(-800)}`);
  }
  const out = (r.stdout || '').trim();
  const line = out.split(/\r?\n/).filter(Boolean).pop();
  try { return JSON.parse(line); } catch {
    throw new Error(`imgops.py 输出不是 JSON：${out.slice(0, 400)}`);
  }
}

export function ensureDir(p) { mkdirSync(p, { recursive: true }); return p; }

/** 逐张计算客观指标（一次进程算全部，省启动开销） */
export function metrics(paths) {
  if (!paths.length) return [];
  const res = runPy(['metrics', '--json', '-', ...paths]);
  return res.images;
}

/** 拼图：N 张图 → 一张带编号/尺寸/锐度的联络表 */
export function makeSheet(paths, { out, cols = 2, cell = 560 } = {}) {
  const target = out || join(CACHE_DIR, 'sheets', `sheet_${Date.now()}.jpg`);
  ensureDir(dirname(target));
  return runPy(['sheet', '--out', target, '--cols', String(cols), '--cell', String(cell), ...paths]);
}

export function makeThumb(src, { out, max = 1024, quality = 92 } = {}) {
  const target = out || join(CACHE_DIR, 'preview', `${hash(src)}_${max}.jpg`);
  ensureDir(dirname(target));
  runPy(['thumb', '--in', src, '--out', target, '--max', String(max), '--quality', String(quality)]);
  return target;
}

const hash = (s) => createHash('md5').update(s).digest('hex').slice(0, 16);

/** 把一次产物落成本地文件：优先输出目录，其次下载到缓存 */
export async function materialize(file) {
  const local = localOutputPath(file);
  if (local) return { path: local, source: 'local', bytes: statSync(local).size };
  const key = hash(`${file.type}/${file.subfolder}/${file.filename}`);
  const ext = extname(file.filename) || '.png';
  const dest = join(CACHE_DIR, 'images', key + ext);
  if (existsSync(dest) && statSync(dest).size > 0) {
    return { path: dest, source: 'cache', bytes: statSync(dest).size };
  }
  const { buf } = await viewBytes(file);
  ensureDir(dirname(dest));
  writeFileSync(dest, buf);
  return { path: dest, source: 'download', bytes: buf.length };
}

export function fileInfo(path) {
  return { path, bytes: statSync(path).size, mtime: statSync(path).mtimeMs };
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
export function mimeOf(path) { return MIME[extname(path).toLowerCase()] || 'image/png'; }

/**
 * 生成给视觉模型看的图片内容：小图原样返回，大图压到 maxSide + JPEG q92。
 * 目的：既保住判断锐度/细节所需的分辨率，又不把上下文预算烧在 3MB PNG 上。
 */
// 小于这个体积就直接回原图，超过就压成 JPEG：控制进上下文的 token，而不是无脑塞 3MB PNG
const MAX_INLINE_BYTES = 450_000;

export function previewFor(path, { maxSide = 1280 } = {}) {
  const bytes = statSync(path).size;
  if (bytes <= MAX_INLINE_BYTES) {
    return { data: readFileSync(path).toString('base64'), mimeType: mimeOf(path), path, bytes, mode: 'original' };
  }
  const out = makeThumb(path, { max: maxSide, quality: 92 });
  return { data: readFileSync(out).toString('base64'), mimeType: 'image/jpeg', path: out, bytes: statSync(out).size, mode: 'preview' };
}
