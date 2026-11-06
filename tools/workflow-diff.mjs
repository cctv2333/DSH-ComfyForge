#!/usr/bin/env node
// tools/workflow-diff.mjs —— 逐节点对比两份 ComfyUI 工作流，专抓"改了但没人告诉你"的静默差异
//
// 为什么需要它：
//   ComfyUI 的 POST /prompt 只校验三件事（节点类型存在、必填输入连了、widget 类型对）。
//   它**不会**告诉你：某个节点定义了却没人引用、某个输入的槽位抄错了一格、
//   两份工作流同名节点的连线来源不同。这些错误都表现为"node_errors: {}，能跑，但结果坏"。
//   2026-11-06 实录：4 个这样的静默错误全部通过了 ComfyUI 校验（其中一个是满屏彩色碎片）。
//
// 参考过的现有实现：
//   artokun/comfyui-mcp 的 /comfy-compare（对比两份工作流）
//   artokun/comfyui-mcp PR #175 graph-health heuristics（悬空/孤立/断链）
//   lostmywind/comfyui-workflow-doctor（缺节点 + 缺模型）
//   它们没覆盖的一条：**槽位语义差异**（同一节点同一输入，取 output 还是 denoised_output）
//
// 差异分级（越上面越该当场看）：
//   slot  同源节点、不同输出槽   —— 最高危，肉眼几乎看不出来（今天碎片就是这么来的）
//   input 两边都是连线但源节点类型不同
//   value 常量值不同
//   weak  一侧是计算节点/混合形态，静态判断不了，仅供参考
//
// 用法：
//   node tools/workflow-diff.mjs <参考.json> <我的.json> [--json] [--quiet]
//   支持：UI 格式（nodes+links）、API 格式（{id:{class_type,inputs}}）、
//         以及从 mp4 用 ffmpeg -f ffmetadata 导出的文本（会自动解转义找 prompt=）
import fs from 'node:fs';
import path from 'node:path';

import { workflowFormat } from '../mcp/lib/workflowcheck.mjs';

// ── 载入 ──────────────────────────────────────────────────────────────
function unescapeFf(v) {
  return v.replace(/\\\\/g, '\u0000').replace(/\\([;#=])/g, '$1').replace(/\u0000/g, '\\');
}

function load(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('prompt='));
  if (line) return JSON.parse(unescapeFf(line.slice('prompt='.length))); // ffmetadata
  return JSON.parse(raw);
}

// 只承载一个值、本身不参与计算的节点：比较时应追到"值"而不是"有没有这个节点"
const CONST_NODES = /^(INTConstant|FloatConstant|PrimitiveFloat|PrimitiveInt|PrimitiveString|PrimitiveBoolean|Int Literal|Float Literal|String Literal|Seed \(rgthree\)|Text|String)$/i;
// 直通节点：输入原样传给输出，比较时应穿透到上游
const PASSTHROUGH = /^(Reroute|ModelPreviewOverrideKJ|PrimitiveNode)$/i;
// 需要运行时才能算出值：静态无法判断等价，只能标 weak
const COMPUTED = /^(ComfyMathExpression|ResolutionSelector|ComfyMathExpression.*|Comfy.*Math.*)$/i;
// 终端输出节点：没有下游是正常的
const TERMINAL = /^(VAEDecode|VAEDecodeAudio|SaveImage|PreviewImage|VHS_VideoCombine|SaveVideo|SaveAudio|CreateVideo|PreviewAudio|SaveAnimatedWEBP|PreviewAny)$/i;
// 纯 UI 节点：不参与计算，悬空也正常
const UI_ONLY = /^(Note|MarkdownNote|Label.*|GetNode|SetNode)$/i;

// ── 统一成图模型 ──────────────────────────────────────────────────────
function toGraph(doc) {
  const fmt = workflowFormat(doc);
  const nodes = new Map();
  const consumers = new Map();

  if (fmt === 'ui') {
    const linkById = new Map();
    for (const L of doc.links || []) {
      if (!Array.isArray(L) || L.length < 5) continue;
      linkById.set(L[0], { srcId: String(L[1]), srcSlot: L[2], dstId: String(L[3]) });
    }
    for (const n of doc.nodes || []) {
      if (!n || !n.type) continue;
      const inputs = new Map();
      for (const i of n.inputs || []) {
        if (i.link != null && linkById.has(i.link)) {
          const L = linkById.get(i.link);
          inputs.set(i.name, { kind: 'link', srcId: L.srcId, srcSlot: L.srcSlot });
        }
      }
      nodes.set(String(n.id), {
        id: String(n.id), type: n.type, title: n.title || '',
        inputs, widgets: n.widgets_values ?? null,
      });
    }
    for (const L of linkById.values()) {
      if (!consumers.has(L.srcId)) consumers.set(L.srcId, []);
      consumers.get(L.srcId).push(L.dstId);
    }
  } else if (fmt === 'api') {
    for (const [id, n] of Object.entries(doc)) {
      if (!n || typeof n !== 'object' || !n.class_type) continue;
      const inputs = new Map();
      for (const [name, v] of Object.entries(n.inputs || {})) {
        if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number') {
          inputs.set(name, { kind: 'link', srcId: String(v[0]), srcSlot: v[1] });
        } else {
          inputs.set(name, { kind: 'value', value: v });
        }
      }
      nodes.set(String(id), { id: String(id), type: n.class_type, title: n._meta?.title || '', inputs, widgets: null });
    }
    for (const [id, n] of nodes) {
      for (const i of n.inputs.values()) {
        if (i.kind !== 'link') continue;
        if (!consumers.has(i.srcId)) consumers.set(i.srcId, []);
        consumers.get(i.srcId).push(id);
      }
    }
  } else {
    throw new Error('认不出的工作流格式（既不是 UI 的 nodes[]，也不是 API 的 class_type）');
  }
  return { format: fmt, nodes, consumers };
}

const byType = (g) => {
  const m = new Map();
  for (const n of g.nodes.values()) {
    if (!m.has(n.type)) m.set(n.type, []);
    m.get(n.type).push(n);
  }
  return m;
};

// 把一个输入追到"语义源"：常量给值、直通节点穿透、其余给类型+槽位
function resolveSource(g, nodeId, slot, depth = 0) {
  if (depth > 8) return { kind: 'deep', nodeId };
  const n = g.nodes.get(String(nodeId));
  if (!n) return { kind: 'missing', nodeId: String(nodeId) };
  if (CONST_NODES.test(n.type)) {
    let v = null;
    for (const i of n.inputs.values()) if (i.kind === 'value') v = i.value;
    if (v == null && Array.isArray(n.widgets)) v = n.widgets[0];
    return { kind: 'const', value: v, via: n.type };
  }
  if (COMPUTED.test(n.type)) return { kind: 'computed', type: n.type };
  if (PASSTHROUGH.test(n.type)) {
    for (const i of n.inputs.values()) {
      if (i.kind === 'link') return resolveSource(g, i.srcId, i.srcSlot, depth + 1);
    }
    return { kind: 'passthrough-empty', type: n.type };
  }
  return { kind: 'link', type: n.type, slot, nodeId: n.id };
}

const trunc = (s, n = 80) => {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n)}…(${t.length} 字)` : t;
};

const show = (r) => {
  if (r.kind === 'const') return `常量 ${trunc(JSON.stringify(r.value))}`;
  if (r.kind === 'computed') return `${r.type}(计算)`;
  if (r.kind === 'link') return `${r.type}[${r.slot}]`;
  if (r.kind === 'missing') return `?[${r.nodeId}](缺失)`;
  return r.type ?? r.kind;
};

// ── 对比 ──────────────────────────────────────────────────────────────
function compare(refFile, myFile) {
  const ref = toGraph(load(refFile));
  const my = toGraph(load(myFile));
  const refT = byType(ref);
  const myT = byType(my);

  const out = { ref: refFile, mine: myFile, refFormat: ref.format, myFormat: my.format, findings: [] };
  const push = (kind, text, extra = {}) => out.findings.push({ kind, text, ...extra });

  push('info', `参考：${path.basename(refFile)} (${ref.format}, ${ref.nodes.size} 节点)`);
  push('info', `我的：${path.basename(myFile)} (${my.format}, ${my.nodes.size} 节点)`);

  // ① 节点类型数量
  const allTypes = [...new Set([...refT.keys(), ...myT.keys()])].sort();
  const onlyMine = [], onlyRef = [], countDiff = [];
  for (const t of allTypes) {
    const a = refT.get(t)?.length ?? 0;
    const b = myT.get(t)?.length ?? 0;
    if (a && !b) onlyRef.push(t);
    else if (b && !a) onlyMine.push(t);
    else if (a !== b) countDiff.push({ type: t, ref: a, mine: b });
  }
  for (const t of onlyMine) push('type-only-mine', `只有我有：${t}`, { type: t });
  for (const t of onlyRef) push('type-only-ref', `只有参考有：${t}`, { type: t });
  for (const d of countDiff) push('type-count', `数量不同：${d.type}  我 ${d.mine} / 参考 ${d.ref}`, d);

  // ② 悬空节点
  // 只报"参考里被引用、我这里悬空"——两边都悬空说明是设计如此（终端/预览类节点，
  // 第三方节点太多，TERMINAL 名单永远不全）。自己跟自己比必须 0 条，这是硬要求。
  const refDanglingTypes = new Set(
    [...ref.nodes.values()].filter((n) => !TERMINAL.test(n.type) && !UI_ONLY.test(n.type) && (ref.consumers.get(n.id) || []).length === 0).map((n) => n.type),
  );
  for (const n of my.nodes.values()) {
    if (TERMINAL.test(n.type) || UI_ONLY.test(n.type)) continue;
    if ((my.consumers.get(n.id) || []).length > 0) continue;
    if (refDanglingTypes.has(n.type)) continue; // 两边都悬空 → 不算差异
    push('dangling', `[${n.id}] ${n.type} 没有任何下游  ← 参考里被引用了`, { node: n.id, type: n.type });
  }

  // ③ 同类型唯一时的输入来源对比
  for (const t of allTypes) {
    const ra = refT.get(t) || [];
    const ma = myT.get(t) || [];
    if (ra.length !== 1 || ma.length !== 1) continue;
    const names = new Set([...ra[0].inputs.keys(), ...ma[0].inputs.keys()]);
    for (const name of names) {
      const ri = ra[0].inputs.get(name), mi = ma[0].inputs.get(name);
      const rs = !ri ? { kind: 'unconnected' } : ri.kind === 'value' ? { kind: 'const', value: ri.value } : resolveSource(ref, ri.srcId, ri.srcSlot);
      const ms = !mi ? { kind: 'unconnected' } : mi.kind === 'value' ? { kind: 'const', value: mi.value } : resolveSource(my, mi.srcId, mi.srcSlot);
      const same = show(rs) === show(ms);
      if (same) continue;

      let kind = 'weak';
      if (rs.kind === 'const' && ms.kind === 'const') kind = 'value';
      else if (rs.kind === 'link' && ms.kind === 'link') {
        kind = rs.type === ms.type ? 'slot' : 'input';
      }
      push(kind, `${t}.${name}\n      我 : ${show(ms)}\n      参考: ${show(rs)}`, {
        type: t, input: name, mine: show(ms), ref: show(rs),
      });
    }
  }

  return out;
}

// ── 输出 ──────────────────────────────────────────────────────────────
const ORDER = ['slot', 'input', 'value', 'dangling', 'type-count', 'type-only-mine', 'type-only-ref', 'weak', 'info'];
const TITLE = {
  slot: '同源不同槽位（最高危，肉眼看不出）',
  input: '连线来源不同',
  value: '常量值不同',
  dangling: '悬空节点（定义了但没人用）',
  'type-count': '节点数量不同',
  'type-only-mine': '只有我有',
  'type-only-ref': '只有参考有',
  weak: '结构不同但可能等价（一侧是计算节点/混合形态）',
  info: '概况',
};

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith('--'));
const asJson = argv.includes('--json');
if (files.length !== 2) {
  console.error('用法: node tools/workflow-diff.mjs <参考工作流> <我的工作流> [--json]');
  console.error('支持 UI 格式、API 格式、mp4 的 ffmetadata 导出');
  process.exit(2);
}

let res;
try {
  res = compare(files[0], files[1]);
} catch (e) {
  console.error(`对比失败：${e.message}`);
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}

// 人类可读：按严重度分组
for (const kind of ORDER) {
  const items = res.findings.filter((f) => f.kind === kind);
  if (!items.length) continue;
  console.log(`\n── ${TITLE[kind]} ──`);
  for (const it of items) console.log(`  ${it.text}`);
}
const danger = res.findings.filter((f) => ['slot', 'input', 'dangling'].includes(f.kind)).length;
console.log(`\n合计高危差异（slot / input / dangling）：${danger} 条`);
