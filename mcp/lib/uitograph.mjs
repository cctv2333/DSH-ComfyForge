// lib/uitograph.mjs — API 格式工作流 → ComfyUI 前端能打开的 UI 格式
//
// 为什么需要：ComfyUI 侧边栏只认 UI 格式（nodes/links/widgets_values，带坐标）。
// 我们内部跑的是 API 格式（扁平 {id:{class_type,inputs}}），用户点开就报「打不开」。
//
// 三个必须踩对的坑（都吃过）：
//   1. widgets_values 的顺序必须严格等于 object_info 里 required+optional 的声明顺序，
//      少一位后面全体错位（steps 变成 cfg 这种事）。
//   2. KSampler 的 seed 后面前端还有一个 control_after_generate 控件，object_info 里没有，
//      不补这一位同样全体错位。
//   3. links 里的 target_slot 只数「非 widget」输入，且顺序同上。
//
// 之前 dsh-plugin/index.js 与 tools/to-ui-workflow.mjs 各有一份，逻辑相同但没有共享 ——
// 改一处漏一处，所以抽到这里，两边都从这引。

const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN']);

/** object_info 里这一项是不是「widget（节点上能直接改的值）」而不是「插槽（要点线连的）」 */
export function isWidgetSpec(spec) {
  const t = spec?.[0];
  return Array.isArray(t) || WIDGET_TYPES.has(t);
}

/** API 格式里 ["12", 0] = 从节点 12 的第 0 个输出接线 */
export function isLink(v) {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';
}

const specType = (spec) => String(Array.isArray(spec?.[0]) ? 'COMBO' : spec?.[0] || '*');

/**
 * @param {object} api   API 格式工作流 {id: {class_type, inputs}}
 * @param {object} info  /object_info 的结果
 * @param {object} meta  {name, title}
 * @returns {object|null} UI 格式工作流
 */
export function apiToUiGraph(api, info, meta = {}) {
  const ids = Object.keys(api || {});
  if (!ids.length) return null;

  // —— 依赖层级 → 列（只为让图别糊成一团，不影响执行）——
  const parents = Object.fromEntries(ids.map((id) => [id, []]));
  for (const [id, n] of Object.entries(api)) {
    for (const v of Object.values(n.inputs || {})) if (isLink(v)) parents[id].push(v[0]);
  }
  const depth = {};
  for (const id of ids) {
    const walk = (cur, seen) => {
      if (depth[cur] !== undefined) return depth[cur];
      if (seen.has(cur)) return 0;
      seen.add(cur);
      let d = 0;
      for (const p of parents[cur] || []) d = Math.max(d, walk(p, seen) + 1);
      depth[cur] = d;
      return d;
    };
    walk(id, new Set());
  }
  const columns = {};
  for (const id of ids) (columns[depth[id]] ||= []).push(id);

  const NODE_W = 320;
  const COL_GAP = 90;
  const pos = {};
  for (const [dStr, col] of Object.entries(columns)) {
    const d = Number(dStr);
    col.sort((a, b) => Number(a) - Number(b)).forEach((id, i) => { pos[id] = [60 + d * (NODE_W + COL_GAP), 80 + i * 190]; });
  }

  // —— 每个节点的插槽顺序（= 前端显示顺序）——
  const linkInputs = {};
  for (const [id, n] of Object.entries(api)) {
    const def = (info && info[n.class_type]) || {};
    const all = [...Object.entries(def.input?.required || {}), ...Object.entries(def.input?.optional || {})];
    const list = [];
    for (const [name, spec] of all) {
      if (isWidgetSpec(spec)) continue;
      list.push({ name, type: specType(spec) });
    }
    // 自定义节点的输入可能不在 object_info 里，按实际连线补在末尾
    for (const [name, v] of Object.entries(n.inputs || {})) {
      if (isLink(v) && !list.some((x) => x.name === name)) list.push({ name, type: '*' });
    }
    linkInputs[id] = list;
  }

  // —— 连线 ——
  const links = [];
  const linkMap = new Map();
  let linkId = 0;
  for (const [id, n] of Object.entries(api)) {
    const list = linkInputs[id];
    for (const [name, v] of Object.entries(n.inputs || {})) {
      if (!isLink(v)) continue;
      const slot = list.findIndex((x) => x.name === name);
      const lid = ++linkId;
      linkMap.set(`${id}:${name}`, lid);
      links.push([lid, Number(v[0]), v[1], Number(id), slot < 0 ? 0 : slot, list[slot]?.type || '']);
    }
  }

  // —— 节点 ——
  const nodes = [];
  for (const [id, n] of Object.entries(api)) {
    const cls = n.class_type;
    const def = (info && info[cls]) || {};
    const all = [...Object.entries(def.input?.required || {}), ...Object.entries(def.input?.optional || {})];
    const inputs = [];
    const widgets = [];
    for (const [name, spec] of all) {
      const v = n.inputs?.[name];
      if (isWidgetSpec(spec)) {
        widgets.push(v !== undefined ? v : (spec?.[1]?.default ?? null));
      } else {
        const lid = v !== undefined && isLink(v) ? linkMap.get(`${id}:${name}`) : null;
        inputs.push({ name, type: specType(spec), link: lid ?? null });
      }
    }
    for (const [name, v] of Object.entries(n.inputs || {})) {
      if (!isLink(v)) continue;
      if (inputs.some((x) => x.name === name)) continue;
      inputs.push({ name, type: '*', link: linkMap.get(`${id}:${name}`) ?? null });
    }
    // 前端在 seed 后面多一位 control_after_generate，object_info 里没有
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

    nodes.push({
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

  return {
    last_node_id: Math.max(...nodes.map((n) => n.id)),
    last_link_id: linkId,
    nodes,
    links,
    groups: [],
    config: {},
    extra: { ds: { scale: 0.85, offset: [0, 0] }, comfyforge: { name: meta.name || '', title: meta.title || '' } },
    version: 0.4,
  };
}

/** 把模板的 defaults 按 bindings 填进 API 图，让打开时看到的是真实可跑的值而不是空串 */
export function applyTemplateDefaults(tpl) {
  const wf = JSON.parse(JSON.stringify(tpl.workflow || {}));
  const bindings = tpl.bindings || {};
  const defaults = tpl.defaults || {};
  const applied = [];
  for (const [key, target] of Object.entries(bindings)) {
    if (!(key in defaults)) continue;
    if (!Array.isArray(target) || target.length !== 2) continue;
    const [nodeId, inputName] = target;
    const node = wf[nodeId];
    if (!node || !node.inputs) continue;
    node.inputs[inputName] = defaults[key];
    applied.push(`${nodeId}.${inputName}=${key}`);
  }
  return { workflow: wf, applied };
}

/** 体检一份 UI 图：节点类型是否都在 object_info、连线两端是否都存在、widget 数量是否对得上 */
export function auditUiGraph(ui, info) {
  const problems = [];
  const byId = new Map((ui.nodes || []).map((n) => [n.id, n]));
  for (const n of ui.nodes || []) {
    const def = info?.[n.type];
    if (!def) { problems.push(`节点 ${n.id} 类型 ${n.type} 不在 /object_info（打开会报缺节点）`); continue; }
    const all = [...Object.entries(def.input?.required || {}), ...Object.entries(def.input?.optional || {})];
    const expectWidgets = all.filter(([, spec]) => isWidgetSpec(spec)).length
      + ((n.type === 'KSampler' || n.type === 'KSamplerAdvanced') ? 1 : 0);
    if ((n.widgets_values || []).length < expectWidgets) {
      problems.push(`节点 ${n.id} ${n.type} widget 只有 ${n.widgets_values.length} 位，期望 ≥${expectWidgets}（会错位）`);
    }
    for (const inp of n.inputs || []) {
      if (inp.link === null || inp.link === undefined) continue;
      const link = (ui.links || []).find((l) => l[0] === inp.link);
      if (!link) problems.push(`节点 ${n.id} 输入 ${inp.name} 指向不存在的连线 ${inp.link}`);
      else if (!byId.has(link[1])) problems.push(`节点 ${n.id} 输入 ${inp.name} 的源节点 ${link[1]} 不存在`);
    }
  }
  return problems;
}
