// lib/workflows.mjs — 读 ComfyUI 里的「别人怎么做的」：把保存的工作流拆成节点/模型/插件需求
//
// 为什么要它：用户/同事给的 .json 工作流，第一问题永远是「这套要装什么插件、用哪个模型、缺哪一步」。
// 这里只做只读解析，不执行、不改文件。
//
// UI 格式（ComfyUI 前端保存的）比 API 格式多一层包装：
//   { nodes: [{ id, type, widgets_values, inputs }], links: [[id, src, slot, dst, slot, type]], groups }
// 我们只关心 nodes[].type（= 节点类名）和 values 里的模型文件名。
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { COMFY_ROOT, PROJECT_ROOT } from './config.mjs';

const MODEL_EXT = /\.(safetensors|gguf|ckpt|pt|pth|bin|onnx)$/i;

export function workflowDir() {
  if (!COMFY_ROOT) return null;
  return join(COMFY_ROOT, 'user', 'default', 'workflows');
}

export function listWorkflows() {
  const dir = workflowDir();
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).map((f) => {
    const p = join(dir, f);
    let nodeCount = 0, error = null;
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      nodeCount = Array.isArray(j.nodes) ? j.nodes.length : Object.keys(j).length;
    } catch (e) { error = e.message; }
    return { name: f.replace(/\.json$/i, ''), path: p, nodes: nodeCount, error };
  });
}

/**
 * 拆解一个工作流（UI 或 API 格式都收）：
 *  - nodes: 用到的节点类名（去重、带出现次数）
 *  - models: 出现在参数值里的模型文件名
 *  - inputs: 非模型的文件名（参考图等）
 */
export function inspectWorkflow(path) {
  const raw = readFileSync(path, 'utf8');
  const j = JSON.parse(raw);
  const isUi = Array.isArray(j.nodes);
  const nodes = new Map();   // class -> count
  const models = new Set();
  const inputs = new Set();

  const bump = (cls) => { if (cls) nodes.set(cls, (nodes.get(cls) || 0) + 1); };

  if (isUi) {
    for (const n of j.nodes) {
      bump(n.type);
      const vals = Array.isArray(n.widgets_values) ? n.widgets_values : [];
      for (const v of vals) {
        if (typeof v !== 'string' || !v.includes('.')) continue;
        if (MODEL_EXT.test(v)) models.add(v);
        else if (/\.(png|jpe?g|webp)$/i.test(v)) inputs.add(v);
      }
    }
  } else {
    for (const n of Object.values(j)) {
      bump(n?.class_type);
      for (const v of Object.values(n?.inputs || {})) {
        if (typeof v !== 'string' || !v.includes('.')) continue;
        if (MODEL_EXT.test(v)) models.add(v);
        else if (/\.(png|jpe?g|webp)$/i.test(v)) inputs.add(v);
      }
    }
  }
  return {
    path, format: isUi ? 'ui' : 'api',
    nodes: [...nodes.entries()].map(([cls, count]) => ({ class_type: cls, count })).sort((a, b) => b.count - a.count),
    models: [...models], inputs: [...inputs],
  };
}

/** 本机已装的插件包（名 + 若能读到就附仓库地址） */
export function installedPacks() {
  const dir = COMFY_ROOT ? join(COMFY_ROOT, 'custom_nodes') : null;
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('__') && e.name !== '.disabled')
    .map((e) => {
      const p = join(dir, e.name);
      let url = null;
      // 插件自己通常会在 README / pyproject / .tracking 里写仓库地址
      for (const f of ['pyproject.toml', 'README.md', '.tracking']) {
        const fp = join(p, f);
        if (!existsSync(fp)) continue;
        try {
          const m = readFileSync(fp, 'utf8').match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/);
          if (m) { url = m[0]; break; }
        } catch { /* 忽略读不到的 */ }
      }
      return { name: e.name, path: p, url };
    });
}

/**
 * 判断工作流里每个节点在本机的归属：内置 / 已装插件 / 缺失。
 * 缺失节点的归属需要联网查 ComfyUI-Manager 的 registry（这里不联网，只报「缺」）。
 */
export function classifyNodes(nodeList, objectInfo, packs = []) {
  const known = objectInfo ? new Set(Object.keys(objectInfo)) : null;
  return nodeList.map(({ class_type, count }) => {
    const installed = known ? known.has(class_type) : null;
    return { class_type, count, installed, origin: installed === false ? 'missing' : installed ? 'local' : 'unknown' };
  });
}

/** 生成一份人/agent 都能读的工作流说明（Markdown） */
export function renderWorkflowDoc(info, { classified = [], packHints = [] } = {}) {
  const missing = classified.filter((c) => c.origin === 'missing');
  const lines = [
    `# 工作流：${info.path.split(/[\\/]/).pop().replace(/\.json$/i, '')}`,
    '',
    `- 格式：${info.format === 'ui' ? 'UI（前端保存）' : 'API（提交格式）'}`,
    `- 节点数：${info.nodes.reduce((n, x) => n + x.count, 0)}（去重 ${info.nodes.length} 类）`,
    `- 模型文件：${info.models.length ? info.models.join('、') : '（无）'}`,
    info.inputs.length ? `- 输入文件：${info.inputs.join('、')}` : null,
    '',
    '## 节点清单',
    '',
    '| 节点 | 次数 | 本机状态 |',
    '|---|---|---|',
    ...info.nodes.map((n) => {
      const c = classified.find((x) => x.class_type === n.class_type);
      const st = c?.origin === 'missing' ? '**缺失**' : c?.origin === 'local' ? '已安装' : '未知（ComfyUI 没连上）';
      return `| ${n.class_type} | ${n.count} | ${st} |`;
    }).filter(Boolean),
    '',
  ];
  if (missing.length) {
    lines.push(`## 需要补的插件（${missing.length} 个节点类缺失）`, '');
    lines.push(...missing.map((m) => `- \`${m.class_type}\`（出现 ${m.count} 次）`));
    lines.push('', '> 这些节点类不在本机的 object_info 里。要到 ComfyUI-Manager 的 registry 里查归属插件，需要联网；', '> 也可以直接问工作流作者，或把同名插件目录放进 custom_nodes。');
  } else if (classified.length) {
    lines.push('## 依赖结论', '', '本机节点齐全，可以直接跑（模型文件是否齐另见能力清单）。');
  }
  if (packHints.length) {
    lines.push('', '## 本机已装插件（可能相关）', '');
    lines.push(...packHints.slice(0, 12).map((p) => `- ${p.name}${p.url ? ` — ${p.url}` : ''}`));
  }
  return lines.filter((l) => l !== null).join('\n');
}

export function writeDoc(name, markdown) {
  const dir = join(PROJECT_ROOT, 'docs', 'workflows');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${String(name).replace(/[\\/:*?"<>|]/g, '_')}.md`);
  writeFileSync(p, markdown, 'utf8');
  return p;
}
