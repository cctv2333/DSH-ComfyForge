// lib/workflowcheck.mjs — 工作流"缺件"体检
//
// 判定分四档（这是关键，别混为一谈）：
//   A 已装未加载 —— 包目录在 custom_nodes 里，但节点不在 /object_info → 重启 ComfyUI
//   B 未安装     —— 仓库目录不存在 → 需要装（给出 GitHub 地址）
//   C 来源未知   —— 本地 node-map 查不到 → 人工确认
//   D 前端节点   —— 只有 JS 注册、没有 Python 类（rgthree 的 Label 等），/object_info 永远看不到，属正常
//
// 只读：不写 ComfyUI 目录、不装任何东西。
import fs from 'node:fs';
import path from 'node:path';

import { COMFY_ROOT, objectInfo } from './comfy.mjs';

const IGNORE = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode', 'PreviewAny', '']);
const SKIP_DIRS = /^(__pycache__|\.git|node_modules|\.github|assets|images|web|docs|examples|Workflows|workflow_templates)$/i;
const SKIP_DIRS_JS = /^(__pycache__|\.git|node_modules|\.github|assets|images|docs|examples|Workflows|workflow_templates)$/i;

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// remote 模式（没设 comfyRoot）时 COMFY_ROOT 是 null —— 这里必须判空。
// 曾因为裸写 path.join(null, ...) 导致整个 MCP 服务在 ESM 链接阶段就崩、工具一个都注册不上。
// 教训：本机一直有 ComfyUI，COMFY_ROOT 永不为 null，所以这条路径从来没被走到过。
export const CUSTOM_NODES = COMFY_ROOT ? path.join(COMFY_ROOT, 'custom_nodes') : null;
const NODE_MAP_PATH = CUSTOM_NODES
  ? path.join(CUSTOM_NODES, 'ComfyUI-Manager', 'extension-node-map.json')
  : null;
/** 是否具备"看本地 custom_nodes"的能力。false = remote 模式，只能靠 /object_info 判 A/B 档 */
export const LOCAL_READY = Boolean(CUSTOM_NODES);

/** 从 UI 格式 / API 格式 / subgraph 里抽节点类型 */
export function extractTypes(doc) {
  const types = new Map();
  if (Array.isArray(doc?.nodes)) {
    for (const n of doc.nodes) {
      if (n?.type && !IGNORE.has(n.type)) types.set(n.type, n.title || '');
    }
    for (const sg of doc.definitions?.subgraphs || []) {
      for (const n of sg.nodes || []) {
        if (n?.type && !IGNORE.has(n.type)) types.set(n.type, n.title || '');
      }
    }
  } else if (doc && typeof doc === 'object') {
    for (const v of Object.values(doc)) {
      if (v && typeof v === 'object' && v.class_type && !IGNORE.has(v.class_type)) {
        types.set(v.class_type, v._meta?.title || '');
      }
    }
  }
  return types;
}

export function workflowFormat(doc) {
  if (Array.isArray(doc?.nodes)) return 'ui';
  if (doc && typeof doc === 'object' && Object.values(doc).some((v) => v?.class_type)) return 'api';
  return 'unknown';
}

export function collectWorkflowFiles(target) {
  const st = fs.statSync(target);
  if (!st.isDirectory()) return [target];
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.json')) out.push(p);
    }
  };
  walk(target);
  return out;
}

export function loadNodeMap() {
  if (!NODE_MAP_PATH) return {};
  try {
    return JSON.parse(fs.readFileSync(NODE_MAP_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function typeToRepoIndex(nodeMap) {
  const idx = new Map();
  for (const [url, val] of Object.entries(nodeMap || {})) {
    const list = Array.isArray(val) ? val[0] : null;
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (!idx.has(t)) idx.set(t, []);
      idx.get(t).push(url);
    }
  }
  return idx;
}

export function installedPackDirs() {
  if (!CUSTOM_NODES) return new Set();
  try {
    return new Set(
      fs.readdirSync(CUSTOM_NODES)
        .filter((d) => {
          try { return fs.statSync(path.join(CUSTOM_NODES, d)).isDirectory(); } catch { return false; }
        })
        .map(norm),
    );
  } catch {
    return new Set();
  }
}

/**
 * 扫本地 Python 源码，确认节点是否真的"定义在本机某个包里"。
 * 必须是注册成映射键的形态 `"Type": cls`；出现在 `"class_type": "Type"` 里的是引用，不算定义。
 */
export function scanLocalDefs(wanted) {
  const found = new Map();
  const todo = new Set(wanted);
  if (!todo.size || !CUSTOM_NODES || !fs.existsSync(CUSTOM_NODES)) return found;

  for (const dir of fs.readdirSync(CUSTOM_NODES)) {
    const packDir = path.join(CUSTOM_NODES, dir);
    let st;
    try { st = fs.statSync(packDir); } catch { continue; }
    if (!st.isDirectory() || SKIP_DIRS.test(dir)) continue;

    const walk = (d, depth) => {
      if (depth > 2 || !todo.size) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!todo.size) return;
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.test(e.name)) continue;
          walk(p, depth + 1);
        } else if (e.name.endsWith('.py')) {
          let txt;
          try {
            if (fs.statSync(p).size > 3 * 1024 * 1024) continue;
            txt = fs.readFileSync(p, 'utf8');
          } catch { continue; }
          for (const t of [...todo]) {
            const re = new RegExp(`["']${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*:`);
            if (re.test(txt)) { found.set(t, dir); todo.delete(t); }
          }
        }
      }
    };
    walk(packDir, 0);
  }
  return found;
}

/**
 * 扫本地前端扩展（.js），识别"只有 JS 注册、没有 Python 类"的节点。
 * 这类节点（rgthree 的 Label / Fast Bypasser 等）永远不出现在 /object_info 里，
 * 但完全正常——不能报成缺件。
 *
 * 判据：类型名带括号后缀的（"Label (rgthree)"），去掉后缀后在前端源码里出现过；
 *       或完整类型名本身出现在 .js 里，且该文件有节点注册/类定义的痕迹。
 */
export function scanFrontendDefs(wanted) {
  const found = new Map();
  if (!wanted.length || !CUSTOM_NODES || !fs.existsSync(CUSTOM_NODES)) return found;

  const bases = new Map();
  for (const t of wanted) {
    const b = t.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (b && b !== t) bases.set(b, t);
  }
  if (!bases.size) return found;

  const walk = (dir, depth) => {
    if (depth > 4 || found.size >= bases.size) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS_JS.test(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
        continue;
      }
      if (!e.name.endsWith('.js')) continue;
      const p = path.join(dir, e.name);
      let txt;
      try {
        if (fs.statSync(p).size > 5 * 1024 * 1024) continue;
        txt = fs.readFileSync(p, 'utf8');
      } catch { continue; }

      for (const [base, type] of [...bases]) {
        if (found.has(type)) continue;
        const suffix = (type.match(/\(([^)]*)\)\s*$/) || [])[1];
        // 带括号后缀的类型，要求文件里也出现这个后缀，避免把无关文件算成来源
        if (suffix && !txt.includes(`(${suffix})`)) continue;
        const hit = txt.includes(`'${base}'`) || txt.includes(`"${base}"`)
          || txt.includes(`'${type}'`) || txt.includes(`"${type}"`);
        if (!hit) continue;
        if (/registerNodeType|getNodeType|nodeType|class\s+\w+/.test(txt)) found.set(type, e.name);
      }
    }
  };
  if (CUSTOM_NODES) walk(CUSTOM_NODES, 0);
  return found;
}

/**
 * 体检一批工作流。
 * @param {string[]} targets 文件或目录
 * @param {{ objectInfo?: object }} [opts]
 * @returns {Promise<{knownTypes:number, report:Array, totalMissing:number}>}
 */
export async function checkWorkflows(targets, opts = {}) {
  const oi = opts.objectInfo || (await objectInfo({ maxAgeMs: 0 }));
  const known = new Set(Object.keys(oi));

  const nodeMap = loadNodeMap();
  const repoIndex = typeToRepoIndex(nodeMap);
  const packs = installedPackDirs();

  const docs = [];
  for (const target of targets) {
    for (const file of collectWorkflowFiles(target)) {
      try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        docs.push({ file, doc, types: extractTypes(doc) });
      } catch (e) {
        docs.push({ file, error: `parse: ${e.message}` });
      }
    }
  }

  const unresolved = [];
  for (const d of docs) {
    if (d.error) continue;
    for (const t of d.types.keys()) if (!known.has(t)) unresolved.push(t);
  }
  const localDefs = scanLocalDefs(unresolved);
  const frontendDefs = scanFrontendDefs(unresolved.filter((t) => !localDefs.has(t)));

  const report = [];
  let totalMissing = 0;
  for (const d of docs) {
    if (d.error) { report.push(d); continue; }
    const missing = [];
    for (const [type, title] of d.types) {
      if (known.has(type)) continue;
      const repos = repoIndex.get(type) || [];
      const installedRepo = repos.find((u) => packs.has(norm(u.split('/').pop())));
      const local = localDefs.get(type) || null;
      const frontend = frontendDefs.get(type) || null;
      let verdict;
      let repo = null;
      if (installedRepo) { verdict = 'A_已装未加载'; repo = installedRepo; }
      else if (local) { verdict = 'A_已装未加载'; }
      else if (frontend) { verdict = 'D_前端节点'; }
      else if (repos.length) { verdict = 'B_未安装'; repo = repos[0]; }
      else { verdict = 'C_来源未知'; }
      missing.push({ type, title, repo, candidates: repos.slice(0, 3), local, frontend, verdict });
    }
    // 前端节点不算缺件——它们本来就没有后端类
    totalMissing += missing.filter((m) => m.verdict !== 'D_前端节点').length;
    report.push({ file: d.file, nodeCount: d.types.size, format: workflowFormat(d.doc), missing });
  }

  return { knownTypes: known.size, report, totalMissing, localAvailable: LOCAL_READY };
}

/** 把 report 渲染成人读文本（CLI 与 MCP 共用） */
export function formatReport({ knownTypes, report, totalMissing, localAvailable }, { cwd = process.cwd() } = {}) {
  const lines = [];
  if (localAvailable === false) {
    lines.push('⚠ remote 模式（没设 comfyRoot）：看不到本地 custom_nodes，');
    lines.push('  A 档（已装未加载）与 D 档（前端节点）无法判定，结论只覆盖 B 档（未安装）/ C 档（来源未知）。');
    lines.push('  想完整检查：设 COMFY_ROOT 指向 ComfyUI 安装目录后重跑。');
    lines.push('');
  }
  lines.push(`已加载节点类型：${knownTypes}`);
  for (const r of report) {
    const rel = path.relative(cwd, r.file) || r.file;
    if (r.error) { lines.push(`✗ ${rel}\n    ${r.error}`); continue; }
    const realMissing = r.missing.filter((m) => m.verdict !== 'D_前端节点');
    if (!realMissing.length && !r.missing.length) {
      lines.push(`✓ ${rel}  (${r.nodeCount} 种节点，全部可用)`);
      continue;
    }
    lines.push(`✗ ${rel}  (${r.nodeCount} 种节点，缺 ${realMissing.length} 个${r.missing.length !== realMissing.length ? `，另有 ${r.missing.length - realMissing.length} 个前端节点` : ''})`);

    const g = { 'A_已装未加载': [], 'B_未安装': [], 'C_来源未知': [], 'D_前端节点': [] };
    for (const m of r.missing) g[m.verdict].push(m);

    if (g['A_已装未加载'].length) {
      lines.push('  A. 已装、但这次没加载 → 重启 ComfyUI 即可：');
      for (const m of g['A_已装未加载']) {
        const where = m.local ? `  [定义在 custom_nodes/${m.local}]` : m.repo ? `  [${m.repo}]` : '';
        lines.push(`     ${m.type}${where}`);
      }
    }
    if (g['B_未安装'].length) {
      lines.push('  B. 没装 → 需要装这些包：');
      const byRepo = new Map();
      for (const m of g['B_未安装']) {
        const k = m.repo || '(未知)';
        if (!byRepo.has(k)) byRepo.set(k, []);
        byRepo.get(k).push(m.type);
      }
      for (const [repo, list] of byRepo) lines.push(`     ${repo}\n       └─ ${list.join(', ')}`);
    }
    if (g['C_来源未知'].length) {
      lines.push('  C. 本地 node-map 查不到来源 → 需要人工确认：');
      for (const m of g['C_来源未知']) lines.push(`     ${m.type}${m.title ? `  (${m.title})` : ''}`);
    }
    if (g['D_前端节点'].length) {
      lines.push('  D. 前端扩展节点（没有 Python 类，/object_info 看不到，属正常，不用装）：');
      for (const m of g['D_前端节点']) lines.push(`     ${m.type}${m.frontend ? `  [${m.frontend}]` : ''}`);
    }
  }
  if (!totalMissing) lines.push('\n没有真正的缺件。');
  return lines.join('\n');
}
