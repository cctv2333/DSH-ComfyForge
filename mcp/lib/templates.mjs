// lib/templates.mjs — 工作流模板库（可读、可改、可复用）+ 运行记录
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR, WORKFLOW_DIR } from './comfy.mjs';
import { modelFromWorkflow, profileFor } from './models.mjs';

const NAME_RE = /^[a-zA-Z0-9_.-]+$/;

export function ensureDirs() {
  mkdirSync(WORKFLOW_DIR, { recursive: true });
  mkdirSync(RUNS_DIR, { recursive: true });
}

export function listTemplates() {
  ensureDirs();
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const t = JSON.parse(readFileSync(join(WORKFLOW_DIR, f), 'utf8'));
        return {
          name: t.name || f.replace(/\.json$/, ''),
          title: t.title || '',
          description: t.description || '',
          model: t.model || '',
          nodes: Object.keys(t.workflow || {}).length,
          params: Object.keys(t.bindings || {}),
          defaults: t.defaults || {},
          recommended_sizes: t.recommended_sizes || [],
        };
      } catch (e) {
        return { name: f, error: '解析失败: ' + e.message };
      }
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function getTemplate(name) {
  if (!NAME_RE.test(name)) throw new Error(`模板名不合法：${name}（只允许字母数字 _ . -）`);
  const p = join(WORKFLOW_DIR, `${name}.json`);
  if (!existsSync(p)) {
    const names = listTemplates().map((t) => t.name);
    throw new Error(`模板 ${name} 不存在。现有：${names.join(', ') || '(空)'}`);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function saveTemplate(name, tpl) {
  if (!NAME_RE.test(name)) throw new Error(`模板名不合法：${name}`);
  if (!tpl || typeof tpl !== 'object') throw new Error('模板必须是对象');
  if (!tpl.workflow || typeof tpl.workflow !== 'object') throw new Error('模板缺少 workflow（API 格式工作流图）');
  ensureDirs();
  const out = { ...tpl, name, ...(tpl.title ? {} : { title: name }) };
  const p = join(WORKFLOW_DIR, `${name}.json`);
  writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
  return { path: p, name, nodes: Object.keys(out.workflow).length };
}

export function deleteTemplate(name) {
  const p = join(WORKFLOW_DIR, `${name}.json`);
  if (!existsSync(p)) throw new Error(`模板 ${name} 不存在`);
  unlinkSync(p);
  return { deleted: p };
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * 把 params 写进 workflow 的绑定位置。
 * bindings = { paramName: [nodeId, inputKey] }，另支持字符串里的 {{paramName}} 占位。
 */
export function resolveTemplate(tpl, params = {}) {
  const wf = clone(tpl.workflow);
  const bindings = tpl.bindings || {};
  const defaults = tpl.defaults || {};
  const applied = {};
  const warnings = [];

  const unknown = Object.keys(params).filter((k) => !(k in bindings));
  const randomize = new Set(tpl.randomize || []);
  for (const k of unknown) {
    if (!String(JSON.stringify(wf)).includes(`{{${k}}}`)) {
      warnings.push(`参数 "${k}" 既没有绑定也没有占位符，被忽略。可用参数：${Object.keys(bindings).join(', ')}`);
    }
  }

  for (const [key, target] of Object.entries(bindings)) {
    if (!Array.isArray(target) || target.length < 2) {
      warnings.push(`绑定 ${key} 格式错误（应为 [nodeId, inputKey]）`);
      continue;
    }
    const [nodeId, inputKey] = target;
    const node = wf[nodeId];
    if (!node) { warnings.push(`绑定 ${key} 指向不存在的节点 ${nodeId}`); continue; }
    const hasParam = params[key] !== undefined;
    let value = hasParam ? params[key] : defaults[key];
    // 「每跑一次换一个随机种子」：模板里写 randomize:["seed"]，或显式传 seed:null
    if (key === 'seed' && (value === null || (value === undefined && randomize.has('seed')))) {
      value = Math.floor(Math.random() * 2147483647);
    }
    if (value === undefined) continue; // 保留工作流里的原值
    node.inputs = node.inputs || {};
    node.inputs[inputKey] = value;
    applied[key] = value;
  }

  // 字符串占位符
  for (const node of Object.values(wf)) {
    for (const [k, v] of Object.entries(node.inputs || {})) {
      if (typeof v === 'string' && v.includes('{{')) {
        node.inputs[k] = v.replace(/\{\{(\w+)\}\}/g, (m, name) =>
          params[name] !== undefined ? String(params[name]) : (defaults[name] !== undefined ? String(defaults[name]) : m));
      }
    }
  }
  return { workflow: wf, applied, warnings };
}

/** 静态校验：类是否存在、必填输入、连线、枚举值，以及本机踩过的坑 */
/**
 * 工作流里的模型是不是「原生约 1MP」那一类（FLUX / SD3 / SDXL）。
 * 用来决定「分辨率偏低」的提示该不该出现——SD1.5 在 512 是正常，不该被报警。
 */
function largeNativeSeries(wf) {
  const m = modelFromWorkflow(wf);
  const fam = String(profileFor(m?.file)?.family || '').toLowerCase();
  if (fam) return ['flux', 'sd3', 'sdxl', 'hunyuan_image'].includes(fam);
  // 模型没登记时退回节点特征：SD3 latent 或 FLUX 的 guidance 节点都意味着大分辨率
  return Object.values(wf || {}).some((n) => n?.class_type === 'EmptySD3LatentImage' || n?.class_type === 'FluxGuidance');
}

export function validateWorkflow(wf, info, tpl = null) {
  const errors = [];
  const warnings = [];
  const hints = [];
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
    return { errors: ['workflow 必须是 {节点id: {class_type, inputs}} 形式的对象'], warnings, hints };
  }
  const ids = Object.keys(wf);
  if (!ids.length) return { errors: ['workflow 里没有节点'], warnings, hints };

  for (const [id, node] of Object.entries(wf)) {
    const cls = node?.class_type;
    if (!cls) { errors.push(`节点 ${id} 缺 class_type`); continue; }
    const def = info[cls];
    if (!def) {
      errors.push(`节点 ${id}：未知节点类型 "${cls}"（本机 ComfyUI 没有这个 class）。可能没装对应插件，或名字拼错。`);
      continue;
    }
    const req = def.input?.required || {};
    const opt = def.input?.optional || {};
    const inputs = node.inputs || {};
    for (const [k] of Object.entries(req)) {
      if (!(k in inputs)) {
        errors.push(`节点 ${id}(${cls}) 缺必填输入 "${k}"`);
      }
    }
    for (const [k, v] of Object.entries(inputs)) {
      if (!(k in req) && !(k in opt)) warnings.push(`节点 ${id}(${cls}) 的输入 "${k}" 不在节点定义中（可能被忽略）`);
      const spec = req[k] || opt[k];
      if (!spec) continue;
      // null 会被 ComfyUI 原样塞进 int()/enum，报出很难懂的类型错，这里提前挡住
      if (v === null || v === undefined) {
        errors.push(`节点 ${id}(${cls}).${k} 是 ${String(v)}；该输入不能为空（数值/字符串/连线都不接受 null）`);
        continue;
      }
      const choices = spec[0];
      if (Array.isArray(choices) && typeof v === 'string' && !choices.includes(v)) {
        warnings.push(`节点 ${id}.${k} = "${v}" 不在可选项里（本机可选：${choices.slice(0, 6).join(', ')}${choices.length > 6 ? '…' : ''}）`);
      }
      // 数值范围：steps=0 / cfg=-1 这类会被 ComfyUI 直接拒，早一点说清楚
      if ((choices === 'INT' || choices === 'FLOAT') && typeof v === 'number') {
        const opt = spec[1] || {};
        if (opt.min !== undefined && v < opt.min) errors.push(`节点 ${id}.${k} = ${v}，小于允许的最小值 ${opt.min}`);
        if (opt.max !== undefined && v > opt.max) errors.push(`节点 ${id}.${k} = ${v}，大于允许的最大值 ${opt.max}`);
        if (choices === 'INT' && !Number.isInteger(v)) warnings.push(`节点 ${id}.${k} = ${v} 不是整数，会被 ComfyUI 截断`);
      }
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number') {
        if (!wf[v[0]]) errors.push(`节点 ${id}.${k} 引用了不存在的节点 ${v[0]}`);
      }
    }
  }

  // —— 本机实测过的坑，直接在提交前拦住 ——
  for (const [id, node] of Object.entries(wf)) {
    const inputs = node.inputs || {};
    if (node.class_type === 'UNETLoader' && typeof inputs.unet_name === 'string' && /nf4|bnb/i.test(inputs.unet_name)) {
      hints.push(`节点 ${id}: ${inputs.unet_name} 是 legacy bitsandbytes nf4 权重，ComfyUI 0.30.2 跑不了（实测 RuntimeError: mat1 and mat2 shapes cannot be multiplied (2304x64 and 1x98304)）。改用 UnetLoaderGGUF + *.gguf。`);
    }
    if (node.class_type === 'UnetLoaderGGUF' && typeof inputs.unet_name === 'string' && !/\.gguf$/i.test(inputs.unet_name)) {
      errors.push(`节点 ${id}: UnetLoaderGGUF 只能加载 .gguf，收到 "${inputs.unet_name}"`);
    }
    if (node.class_type === 'KSampler') {
      const cfg = Number(inputs.cfg);
      const negLink = Array.isArray(inputs.negative) ? wf[inputs.negative[0]] : null;
      const negText = negLink?.inputs?.text;
      if (cfg <= 1.05 && typeof negText === 'string' && negText.trim()) {
        hints.push(`节点 ${id}: cfg=${cfg} 时负向提示词不生效（FLUX dev 是蒸馏模型，cfg 固定 1）。负向分支是白算，删掉或改成空串。`);
      }
      if (Number(inputs.steps) < 8) hints.push(`节点 ${id}: steps=${inputs.steps} 对 FLUX 偏少，20 步左右更稳。`);
    }
    if (node.class_type === 'EmptySD3LatentImage' || node.class_type === 'EmptyLatentImage') {
      const w = Number(inputs.width), h = Number(inputs.height);
      const mp = (w * h) / 1e6;
      // 这条提示只对「原生约 1MP」的模型成立。SD1.5 原生 512（0.26MP），按 0.5MP 报警只会误导，
      // 所以判断依据换成「工作流里实际的模型族」，而不是写死 FLUX/SD3。
      if (mp < 0.5 && largeNativeSeries(wf, info)) {
        hints.push(`节点 ${id}: ${w}x${h}=${mp.toFixed(2)}MP 低于该模型 1MP 左右的原生训练分辨率，细节与构图稳定性都会掉——除非你明确要小图，否则用 1024x1024 或 1344x768。`);
      }
    }
  }
  return { errors, warnings, hints };
}

/** 运行记录：每次成功/失败都落盘，方便回看与复制成模板 */
export function saveRun(record) {
  ensureDirs();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const id = String(record.prompt_id || 'noid');
  // 文件名必须唯一：同一毫秒批量落盘时，只用 id 前 8 位会互相覆盖（吃过这个亏）
  const uniq = `${id.slice(0, 8)}_${Math.random().toString(36).slice(2, 7)}`;
  const p = join(RUNS_DIR, `${ts}_${uniq}.json`);
  const full = { saved_at: new Date().toISOString(), ...record };
  writeFileSync(p, JSON.stringify(full, null, 2), 'utf8');
  // 每份运行记录同时留一份人/agent 都能读的 Markdown（同目录，数据不是文档）
  try { writeFileSync(p.replace(/\.json$/, '.md'), runToMarkdown(full), 'utf8'); } catch { /* 写不了不影响主流程 */ }
  return p;
}

/** 把一条运行记录渲染成可复盘的 Markdown：做了什么、用什么模型、出了什么、判定如何 */
export function runToMarkdown(r) {
  const params = r.params || {};
  const outs = r.outputs || [];
  const lines = [
    `# 运行 ${r.prompt_id || '(无 id)'}`,
    '',
    `- 时间：${r.saved_at || ''}`,
    `- 状态：${r.status || '?'}${r.error ? `（${r.error.exception_message || r.error}）` : ''}`,
    `- 模板：${r.template || '?'}`,
    r.params && r.params.model ? `- 模型：${r.params.model}` : null,
    '',
    '## 参数',
    '',
    '```json',
    JSON.stringify(params, null, 2),
    '```',
    '',
    '## 产物',
    '',
  ].filter((l) => l !== null);
  if (!outs.length) lines.push('（没有产物）');
  for (const o of outs) {
    const q = o.quality || {};
    lines.push(`- \`${o.path || o.filename}\``);
    if (q.width) lines.push(`  - ${q.width}x${q.height}（${q.megapixels}MP）· 锐度 ${q.lap_var_512} · 边缘 ${q.edge_pct}% · 对比 ${q.contrast}`);
    if (q.verdict) lines.push(`  - 判定：${q.verdict.level}${(q.verdict.flags || []).length ? '（' + q.verdict.flags.join(', ') + '）' : ''}`);
  }
  lines.push('', '## 复盘提示', '',
    '- 这张图满足了哪些要求？逐条对照原始需求。',
    '- 与上一版相比，改了哪个变量、指标/观感变化是否对得上？',
    '- 若这轮不理想：下一轮只改一个变量，并写清预期。');
  return lines.join('\n');
}

export function listRuns(limit = 10) {
  ensureDirs();
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => {
      try {
        const r = JSON.parse(readFileSync(join(RUNS_DIR, f), 'utf8'));
        return {
          file: f,
          prompt_id: r.prompt_id,
          status: r.status,
          template: r.template,
          params: r.params,
          images: (r.outputs || []).map((o) => o.filename),
          at: r.saved_at,
        };
      } catch { return { file: f, error: 'unreadable' }; }
    });
}
