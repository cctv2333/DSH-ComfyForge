// tools/to-ui-workflow.mjs — 把 API 格式的工作流（我搭的图）转成 ComfyUI 前端能打开的 UI 格式
// 输出：nodes（含坐标/尺寸/输入输出/link）、links、widgets_values
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

const tplPath = arg('template');
const outPath = arg('out');
if (!tplPath || !outPath) { console.error('需要 --template 与 --out'); process.exit(2); }

const tpl = JSON.parse(readFileSync(tplPath, 'utf8'));
const wf = tpl.workflow || tpl;
const info = await (await fetch(COMFY + '/object_info')).json();

const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN']);
const isWidget = (spec) => {
  const t = spec?.[0];
  return Array.isArray(t) || WIDGET_TYPES.has(t);
};
const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';

// 依赖层级 → 列；同层按 id 排序
const parents = Object.fromEntries(Object.keys(wf).map((id) => [id, []]));
for (const [id, n] of Object.entries(wf)) {
  for (const v of Object.values(n.inputs || {})) if (isLink(v)) parents[id].push(v[0]);
}
const depth = {};
const calc = (id, seen = new Set()) => {
  if (depth[id] !== undefined) return depth[id];
  if (seen.has(id)) return 0;
  seen.add(id);
  let d = 0;
  for (const p of parents[id] || []) d = Math.max(d, calc(p, seen) + 1);
  depth[id] = d;
  return d;
};
Object.keys(wf).forEach((id) => calc(id));

const cols = {};
for (const id of Object.keys(wf)) (cols[depth[id]] ||= []).push(id);

const NODE_W = 320;
const COL_GAP = 90;
const ROW_GAP = 40;
const pos = {};
for (const [dStr, ids] of Object.entries(cols)) {
  const d = Number(dStr);
  ids.sort((a, b) => Number(a) - Number(b)).forEach((id, i) => {
    pos[id] = [60 + d * (NODE_W + COL_GAP), 80 + i * 190];
  });
}

// 每个节点的「连线输入」顺序（= 前端插槽顺序），用于计算 target_slot
const linkInputs = {}; // id -> [{name, type}]
for (const [id, n] of Object.entries(wf)) {
  const def = info[n.class_type] || {};
  const all = [...Object.entries(def.input?.required || {}), ...Object.entries(def.input?.optional || {})];
  const list = [];
  for (const [name, spec] of all) {
    if (isWidget(spec)) continue;
    list.push({ name, type: String(Array.isArray(spec?.[0]) ? 'COMBO' : spec?.[0] || '*') });
  }
  for (const [name, v] of Object.entries(n.inputs || {})) {
    if (isLink(v) && !list.some((x) => x.name === name)) list.push({ name, type: '*' });
  }
  linkInputs[id] = list;
}

const nodesOut = [];
const links = [];
let linkId = 0;
const linkMap = new Map();

for (const [id, n] of Object.entries(wf)) {
  const list = linkInputs[id];
  for (const [name, v] of Object.entries(n.inputs || {})) {
    if (!isLink(v)) continue;
    const slot = list.findIndex((x) => x.name === name);
    const lid = ++linkId;
    linkMap.set(`${id}:${name}`, lid);
    links.push([lid, Number(v[0]), v[1], Number(id), slot < 0 ? 0 : slot, list[slot]?.type || '']);
  }
}


// 目标输入槽位：按 object_info 的 required+optional 顺序里「非 widget」的输入
for (const [id, n] of Object.entries(wf)) {
  const cls = n.class_type;
  const def = info[cls] || {};
  const req = def.input?.required || {};
  const opt = def.input?.optional || {};
  const all = [...Object.entries(req), ...Object.entries(opt)];

  const inputs = [];
  const widgets = [];
  for (const [name, spec] of all) {
    const v = n.inputs?.[name];
    if (isWidget(spec)) {
      widgets.push(v !== undefined ? v : spec?.[1]?.default ?? null);
    } else {
      const lid = v !== undefined && isLink(v) ? linkMap.get(`${id}:${name}`) : null;
      inputs.push({ name, type: String(Array.isArray(spec?.[0]) ? 'COMBO' : spec?.[0] || '*'), link: lid ?? null });
    }
  }
  // 有些输入在 spec 里没有（自定义节点），按实际连线补
  for (const [name, v] of Object.entries(n.inputs || {})) {
    if (!isLink(v)) continue;
    if (inputs.some((x) => x.name === name)) continue;
    inputs.push({ name, type: '*', link: linkMap.get(`${id}:${name}`) ?? null });
  }

  // 前端在 seed 后面多一个 control_after_generate 控件，object_info 里没有；
  // 不补这一位，后续 steps/cfg/sampler 全部错位（这是实测出来的坑）
  if (cls === 'KSampler' || cls === 'KSamplerAdvanced') {
    const at = widgets.length > 1 ? 1 : widgets.length;
    widgets.splice(at, 0, 'randomize');
  }

  const outputs = (def.output || []).map((type, i) => ({
    name: (def.output_name || [])[i] || type,
    type,
    links: links.filter((l) => l[1] === Number(id) && l[2] === i).map((l) => l[0]),
    slot_index: i,
  }));

  nodesOut.push({
    id: Number(id),
    type: cls,
    pos: pos[id],
    size: [NODE_W, 60 + widgets.length * 26 + inputs.length * 24],
    flags: {},
    order: Number(id),
    mode: 0,
    inputs,
    outputs,
    properties: { 'Node name for S&R': cls },
    widgets_values: widgets,
  });
}

const ui = {
  last_node_id: Math.max(...nodesOut.map((n) => n.id)),
  last_link_id: linkId,
  nodes: nodesOut,
  links,
  groups: [],
  config: {},
  extra: { ds: { scale: 0.85, offset: [0, 0] }, comfyforge: { name: tpl.name, title: tpl.title } },
  version: 0.4,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(ui, null, 2), 'utf8');
console.log(JSON.stringify({ out: outPath, nodes: nodesOut.length, links: linkId, name: tpl.name }));
