// tools/plugin-doctor.mjs — 「面板出不来」时，在新机器上一条命令给出结论
//
// 为什么需要：DSH 的报错只给一句 `{slot} 渲染失败：<err>`，不说为什么。
// 而这类故障最常见的原因不是代码，是**路径**：cordis.patch.yml 里写的是另一台机器的
// 绝对路径，格式合法但不存在，于是 runs/live、workflows、.cache 全落在空气里，
// 面板起来是空的、诊断日志也一起丢，界面上一点痕迹都没有。
//
// 这个脚本把「插件到底看到了什么」全部打出来，不用猜：
//   1. 插件目录、解析后的 projectRoot、被忽略的配置路径
//   2. client.js 是否与 client-src 同步（不同步 = 浏览器跑的是旧代码）
//   3. 解析后的 comfyRoot（配置 or 从 /system_stats 反推）
//   4. Host 半有没有真的跑起来（.cache/comfy-live-endpoint.json 是它写的）
//   5. /comfy-live/api/state 有没有应答（有 origin 才能测）
//
// 用法：node tools/plugin-doctor.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const PLUGIN = join(REPO, 'dsh-plugin');

const out = [];
const ok = (s) => out.push(['✓', s]);
const bad = (s) => out.push(['✗', s]);
const warn = (s) => out.push(['!', s]);

// —— 0. 插件在不在 ——
if (!existsSync(join(PLUGIN, 'index.js'))) {
  bad(`找不到插件目录：${PLUGIN}`);
  print();
  process.exit(1);
}
ok(`插件目录 ${PLUGIN}`);

// —— 1. projectRoot 解析（与 dsh-plugin/index.js 里同一套规则）——
const usablePath = (v) => {
  const s = String(v || '').trim();
  if (!s || s.includes('<') || s.includes('>') || s.includes('改成你的')) return '';
  return s;
};
const looksLikeProjectRoot = (p) => {
  if (!p) return false;
  try { return existsSync(join(p, 'mcp', 'server.mjs')) || existsSync(join(p, 'workflows')); } catch { return false; }
};

let cfg = {};
const yml = join(PLUGIN, 'cordis.patch.yml');
if (existsSync(yml)) {
  const text = readFileSync(yml, 'utf8');
  for (const key of ['comfyUrl', 'comfyRoot', 'projectRoot', 'saveWorkflow']) {
    // 只认没被 # 注释掉的行
    const m = text.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm'));
    if (m && !/^\s*#/.test(m[0])) cfg[key] = m[1].replace(/^['"]|['"]$/g, '');
  }
}

const cfgRoot = usablePath(cfg.projectRoot);
const resolvedRoot = cfgRoot && looksLikeProjectRoot(cfgRoot) ? cfgRoot : REPO;

if (!cfgRoot) ok('projectRoot 未写死 → 自动用仓库根');
else if (looksLikeProjectRoot(cfgRoot)) ok(`projectRoot 配置有效：${cfgRoot}`);
else bad(`projectRoot 配置指向的不是本仓库，会被忽略：${cfgRoot}`);
ok(`实际使用 projectRoot = ${resolvedRoot}`);

// 关键目录能不能写
for (const sub of ['runs/live', 'workflows', '.cache']) {
  const p = join(resolvedRoot, sub);
  if (existsSync(p)) ok(`${sub}/ 存在`);
  else warn(`${sub}/ 不存在（插件会自动创建，除非路径不可写）`);
}
if (existsSync(join(resolvedRoot, 'runs'))) {
  try { statSync(join(resolvedRoot, 'runs')); } catch { bad('runs/ 读不了'); }
}

// —— 2. client.js 是否与源码同步 ——
try {
  const SRC = join(PLUGIN, 'client-src');
  const files = readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
  const body = files
    .map((f) => `// ─── ${f} ${'─'.repeat(Math.max(0, 62 - f.length))}\n${readFileSync(join(SRC, f), 'utf8').trimEnd()}\n`)
    .join('\n');
  const expected = `/**\n * Comfy 实时台 — Client 半（由 client-src/*.js 拼装，勿直接编辑本文件）\n * 生成：node build-client.mjs\n */\nwindow.__ModuleLoader__.load({\n  id: '@local/dsh-comfy-live',\n  factory(require) {\n    const React = require('react')\n    const h = React.createElement\n    const { useCallback, useEffect, useMemo, useRef, useState } = React\n\n${body.split('\n').map((l) => (l ? `    ${l}` : '')).join('\n')}\n\n    return { inject: ['slots', 'layout'], apply }\n  },\n})\n`;
  const onDisk = readFileSync(join(PLUGIN, 'client.js'), 'utf8');
  if (expected === onDisk) ok(`client.js 与 client-src 同步（${files.length} 片段）`);
  else bad('client.js 与 client-src 不同步 → 浏览器跑的是旧代码。在 dsh-plugin/ 里跑 node build-client.mjs');
} catch (e) {
  warn(`比对 client.js 失败：${e.message}`);
}

// —— 3. ComfyUI 在哪 ——
const comfyUrl = cfg.comfyUrl || process.env.COMFY_URL || 'http://127.0.0.1:8188';
let stats = null;
try {
  const r = await fetch(`${comfyUrl}/system_stats`, { signal: AbortSignal.timeout(6000) });
  stats = await r.json();
  ok(`ComfyUI 可达 ${comfyUrl}（v${stats?.system?.comfyui_version || '?'}）`);
} catch {
  bad(`ComfyUI 连不上 ${comfyUrl} —— 面板会连不上、时间线空白`);
}

let comfyRoot = usablePath(cfg.comfyRoot);
if (!comfyRoot && stats) {
  for (const a of stats?.system?.argv || []) {
    if (!/main\.py$/i.test(String(a))) continue;
    const root = dirname(String(a));
    if (existsSync(join(root, 'output'))) { comfyRoot = root; break; }
  }
}
if (comfyRoot && existsSync(join(comfyRoot, 'output'))) ok(`ComfyUI 根目录 ${comfyRoot}`);
else bad(`ComfyUI 根目录未知或无效（${comfyRoot || '空'}）→ 产物库与工作流列表会是空的`);

// —— 4. Host 半跑过没有 ——
const ep = join(resolvedRoot, '.cache', 'comfy-live-endpoint.json');
let origin = '';
if (existsSync(ep)) {
  try {
    const j = JSON.parse(readFileSync(ep, 'utf8'));
    origin = j.origin || '';
    ok(`Host 半跑过，记录到的 DSH origin：${origin || '(空)'}`);
  } catch { warn('comfy-live-endpoint.json 存在但读不懂'); }
} else {
  // 注意：这个文件是 Host 半在"收到第一个请求"时才写的。
  // 刚清理过 .cache、或者装好还没打开过面板，都会没有它 —— 所以只算提醒，不算致命。
  warn('没有 .cache/comfy-live-endpoint.json —— 打开一次 DSH 面板后它会自己出现；若一直不出现，才是 Host 半没加载');
}

// —— 5. 路由有没有应答 ——
if (origin) {
  try {
    const r = await fetch(`${origin}/comfy-live/api/state`, { signal: AbortSignal.timeout(6000) });
    const t = await r.text();
    if (r.ok) ok(`/comfy-live/api/state 应答 HTTP ${r.status}（${t.length} 字节）`);
    else bad(`/comfy-live/api/state 返回 HTTP ${r.status}：${t.slice(0, 160)}`);
  } catch (e) {
    bad(`/comfy-live/api/state 请求失败：${e.message}`);
  }
} else {
  warn('拿不到 origin，跳过路由探测（打开 DSH 一次，它就会写下来）');
}

print();

function print() {
  const w = Math.max(...out.map(([m]) => m.length));
  for (const [m, s] of out) console.log(` ${m}  ${s}`);
  const fails = out.filter(([m]) => m === '✗').length;
  console.log(fails ? `\n${fails} 项致命：先把 ✗ 解决，再看面板。` : '\n全绿：路径与构建都对，问题在浏览器侧（打开 DevTools 看 window.__COMFY_LIVE_DIAG__）。');
}
