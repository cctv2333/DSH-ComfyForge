// lib/config.mjs — 唯一的配置来源。
//
// 分发出去以后，"它为什么在我机器上跑不通" 必须能自己说清楚，所以这里的原则是：
//   1) 每个字段都记下「值从哪来」（env / 配置文件 / 自动探测 / 默认）；
//   2) 没有硬编码任何一台机器的绝对路径；
//   3) 缺东西不抛异常、不静默用错值，而是标记 missing 把修法写进提示。
//
// 优先级：环境变量 > comfyforge.config.json > 自动探测 > 内置默认。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 仓库根（含 workflows/、runs/、docs/ 的那一层） */
export const PROJECT_ROOT = resolve(HERE, '..', '..');

export const CONFIG_FILENAME = 'comfyforge.config.json';
export const CONFIG_PATH = process.env.COMFYFORGE_CONFIG
  ? resolve(process.env.COMFYFORGE_CONFIG)
  : join(PROJECT_ROOT, CONFIG_FILENAME);

const isWin = process.platform === 'win32';

// ---------------------------------------------------------------- 配置文件
function readConfigFile() {
  if (!existsSync(CONFIG_PATH)) return { data: {}, error: null, exists: false };
  try {
    const data = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { data: {}, error: '配置文件顶层必须是 JSON 对象', exists: true };
    }
    return { data, error: null, exists: true };
  } catch (e) {
    return { data: {}, error: `配置文件解析失败：${e.message}`, exists: true };
  }
}

const FILE = readConfigFile();

// ---------------------------------------------------------------- 取值助手
/** 取一个字段：env > 文件 > 自动探测 > 默认。每一步都留痕。 */
function pick({ field, envVar, auto, fallback, coerce = String, validate }) {
  const rawEnv = envVar ? process.env[envVar] : undefined;
  if (rawEnv !== undefined && rawEnv !== '') {
    const v = coerce(rawEnv);
    if (validate && !validate(v)) {
      return { value: fallback, source: 'invalid', note: `环境变量 ${envVar}=${rawEnv} 不合法，已改用默认值` };
    }
    return { value: v, source: 'env', note: `来自环境变量 ${envVar}` };
  }
  if (FILE.data[field] !== undefined && FILE.data[field] !== null && FILE.data[field] !== '') {
    const v = coerce(FILE.data[field]);
    if (validate && !validate(v)) {
      return { value: fallback, source: 'invalid', note: `配置项 ${field}=${JSON.stringify(FILE.data[field])} 不合法，已改用默认值` };
    }
    return { value: v, source: 'file', note: `来自 ${CONFIG_FILENAME}` };
  }
  if (auto) {
    const v = auto();
    if (v !== null && v !== undefined) return { value: v, source: 'auto', note: '自动探测到' };
  }
  return { value: fallback, source: fallback === undefined || fallback === null ? 'missing' : 'default', note: '' };
}

const toNum = (v) => Number(v);
const toInt = (v) => Math.round(Number(v));
const isPosNum = (n) => Number.isFinite(n) && n > 0;

// ---------------------------------------------------------------- ComfyUI 根目录
// 只要目录里出现这些之一的「确凿标志」，才认为它是 ComfyUI 根。
// 不用目录名匹配——用户目录名叫什么都行。
const ROOT_MARKERS = ['main.py', 'comfy', 'custom_nodes'];

export function looksLikeComfyRoot(dir) {
  if (!dir || !existsSync(dir)) return false;
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch { return false; }
  let hits = 0;
  for (const m of ROOT_MARKERS) if (existsSync(join(dir, m))) hits += 1;
  return hits >= 2;
}

/**
 * 有界目录扫描：只在「名字里带 comfy」的目录上做候选判定，最多走 maxDirs 个目录 / maxDepth 层。
 * 为什么要扫：安装目录名字千奇百怪（ComfyUI-aki-v3.2、ComfyUI_windows_portable、甚至嵌两层），
 * 靠猜固定路径必然漏；但也不能全盘递归，所以给硬上限。
 */
const SKIP_DIR = /^(node_modules|windows|program files|program files \(x86\)|programdata|appdata|local settings|\$recycle\.bin|system volume information|recovery|perflogs|msocache)$/i;

function scanForComfyRoot(roots, { maxDepth = 3, maxDirs = 2500 } = {}) {
  let visited = 0;
  const queue = roots.filter((r) => existsSync(r)).map((r) => [r, 0]);
  while (queue.length && visited < maxDirs) {
    const [dir, depth] = queue.shift();
    visited += 1;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIR.test(e.name) || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      // 只对「名字像 ComfyUI」的目录做深判定，其余只用来继续下探
      if (/comfy/i.test(e.name)) {
        if (looksLikeComfyRoot(p)) return p;
        for (const inner of ['ComfyUI', join('ComfyUI_windows_portable', 'ComfyUI'), join('resources', 'ComfyUI')]) {
          const q = join(p, inner);
          if (looksLikeComfyRoot(q)) return q;
        }
      }
      if (depth + 1 < maxDepth && !SKIP_DIR.test(e.name)) queue.push([p, depth + 1]);
    }
  }
  return null;
}

/**
 * 自动探测 ComfyUI 根目录：
 *   ① 先在少量「已知安装习惯」的候选里精确找（命中率最高，零成本）；
 *   ② 再上有界扫描兜底。
 */
function autodetectComfyRoot() {
  if (FILE.data.autoDetect === false) return null;
  const cands = [];
  const push = (p) => { if (p) cands.push(p); };

  // ① 精确候选
  push(resolve(PROJECT_ROOT, '..', 'ComfyUI'));      // 和本仓库并排
  push(resolve(PROJECT_ROOT, 'ComfyUI'));            // 套在仓库里
  push(join(homedir(), 'ComfyUI'));
  push(join(homedir(), 'Documents', 'ComfyUI'));
  push(join(homedir(), 'Desktop', 'ComfyUI'));
  if (process.env.LOCALAPPDATA) {
    push(join(process.env.LOCALAPPDATA, 'Programs', '@comfyorgcomfyui-electron', 'resources', 'ComfyUI'));
  }
  const roots = [];
  if (isWin) {
    for (const d of ['C:', 'D:', 'E:', 'F:']) if (existsSync(d + '\\')) roots.push(d + '\\');
  } else {
    roots.push(homedir(), '/opt', '/usr/local', '/usr/share');
  }
  for (const d of roots) {
    push(join(d, 'ComfyUI'));
    push(join(d, 'ComfyUI_windows_portable', 'ComfyUI'));
  }
  for (const c of cands) if (looksLikeComfyRoot(c)) return c;

  // ② 有界扫描
  return scanForComfyRoot(roots);
}

// ---------------------------------------------------------------- Python
/**
 * 找一个真的能 `import PIL, numpy` 的 Python。
 * 顺序：配置/环境变量 → ComfyUI 便携包自带的 python（几乎一定装了 Pillow）→ PATH 里的 python。
 * 只做「存在性」筛选，能不能 import 由 pythonUsable() 实测（doctor 里跑）。
 */
function autodetectPython(comfyRoot) {
  const cands = [];
  if (comfyRoot) {
    cands.push(join(comfyRoot, '..', 'python', 'python.exe')); // ComfyUI_windows_portable\python\python.exe
    cands.push(join(comfyRoot, 'python.exe'));
    cands.push(join(comfyRoot, '..', '..', 'python', 'python.exe'));
  }
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

// ---------------------------------------------------------------- 解析
const comfyRootRes = pick({
  field: 'comfyRoot',
  envVar: 'COMFY_ROOT',
  auto: autodetectComfyRoot,
  fallback: null,
  validate: (v) => existsSync(v),
});

const comfyRoot = comfyRootRes.value && existsSync(comfyRootRes.value) ? comfyRootRes.value : null;

const outputRes = pick({
  field: 'outputDir',
  envVar: 'COMFY_OUTPUT_DIR',
  auto: comfyRoot ? () => join(comfyRoot, 'output') : null,
  fallback: null,
  validate: (v) => existsSync(v),
});

const logRes = pick({
  field: 'logPath',
  envVar: 'COMFY_LOG',
  auto: comfyRoot ? () => {
    // 新版写 user/comfyui.log，老版写根目录 comfyui.log，两个都认
    const a = join(comfyRoot, 'user', 'comfyui.log');
    const b = join(comfyRoot, 'comfyui.log');
    return existsSync(a) ? a : existsSync(b) ? b : a;
  } : null,
  fallback: null,
});

const pythonRes = pick({
  field: 'python',
  envVar: 'COMFYFORGE_PY',
  auto: () => autodetectPython(comfyRoot),
  fallback: null,
  validate: (v) => existsSync(v) || !v.includes('/'),
});

const urlRes = pick({
  field: 'comfyUrl',
  envVar: 'COMFY_URL',
  fallback: 'http://127.0.0.1:8188',
  coerce: (v) => String(v).replace(/\/+$/, ''),
  validate: (v) => /^https?:\/\//i.test(v),
});

const pollRes = pick({
  field: 'pollMs',
  envVar: 'COMFYFORGE_POLL_MS',
  fallback: 1200,
  coerce: toInt,
  validate: isPosNum,
});

const graceRes = pick({
  field: 'graceMs',
  envVar: 'COMFYFORGE_GRACE_MS',
  fallback: 12_000,
  coerce: toInt,
  validate: isPosNum,
});

// ---------------------------------------------------------------- 导出
export const BASE = urlRes.value;
export const COMFY_ROOT = comfyRoot;
export const OUTPUT_DIR = outputRes.value;
export const LOG_PATH = logRes.value;
export const PYTHON = pythonRes.value;
export const POLL_MS = pollRes.value;
export const NOT_QUEUED_GRACE_MS = graceRes.value;

export const CACHE_DIR = join(PROJECT_ROOT, '.cache');
export const WORKFLOW_DIR = join(PROJECT_ROOT, 'workflows');
export const RUNS_DIR = join(PROJECT_ROOT, 'runs');

/** 本模式：能读 ComfyUI 本地文件（同机）还是只能走 HTTP（远程） */
export const MODE = comfyRoot ? 'local' : 'remote';

const FIELDS = [
  ['comfyUrl', urlRes, 'ComfyUI 地址'],
  ['comfyRoot', comfyRootRes, 'ComfyUI 安装目录（读输出/日志用；不填就用 HTTP 远程模式）'],
  ['outputDir', outputRes, '产物目录'],
  ['logPath', logRes, 'comfyui.log 路径'],
  ['python', pythonRes, '跑 imgops.py 的 Python（需 Pillow+numpy）'],
  ['pollMs', pollRes, '轮询间隔'],
  ['graceMs', graceRes, '「既不在队列也不在历史」的宽限期'],
];

/** 逐字段带来源的报告；doctor / comfy_health 都基于它 */
export function describe() {
  return {
    project_root: PROJECT_ROOT,
    config_file: { path: CONFIG_PATH, exists: FILE.exists, error: FILE.error },
    mode: MODE,
    fields: FIELDS.map(([name, r, desc]) => ({
      name,
      value: r.value,
      source: r.source,
      desc,
      note: r.note || undefined,
    })),
    missing: FIELDS.filter(([, r]) => r.value === null || r.value === undefined).map(([name]) => name),
  };
}

/** 给人和模型看的多行文本（doctor 直接用） */
export function describeText() {
  const d = describe();
  const src = { env: '环境变量', file: CONFIG_FILENAME, auto: '自动探测', default: '默认值', missing: '未设置', invalid: '值不合法' };
  const lines = [
    `仓库根：${d.project_root}`,
    `配置文件：${d.config_file.exists ? d.config_file.path : `未使用（可创建 ${CONFIG_PATH}）`}`,
    d.config_file.error ? `配置文件错误：${d.config_file.error}` : null,
    `运行模式：${d.mode === 'local' ? 'local（可读 ComfyUI 本地文件）' : 'remote（只走 HTTP，产物经 /view 下载）'}`,
    '',
    ...d.fields.map((f) => `  ${f.name.padEnd(12)} ${String(f.value).padEnd(48)} [${src[f.source] || f.source}]${f.note ? ' ' + f.note : ''}`),
  ].filter(Boolean);
  return lines.join('\n');
}

/** 缺配置时的统一报错文案，避免各工具各说一套 */
export function requirePath(field, hint) {
  const r = FIELDS.find(([n]) => n === field)?.[1];
  const val = r?.value;
  if (val) return val;
  throw new Error(
    `缺少配置 ${field}。三种设法任选其一：\n` +
    `  1) 环境变量（如 COMFY_ROOT=<ComfyUI 安装目录>）\n` +
    `  2) 在 ${CONFIG_PATH} 里写 {"${field}": "..."}\n` +
    (hint ? `  ${hint}\n` : '') +
    `  3) 跑 node mcp/doctor.mjs 看自动探测到了什么`,
  );
}

export const isAbsolutePath = isAbsolute;
