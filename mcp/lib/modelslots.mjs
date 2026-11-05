// lib/modelslots.mjs —— 模型槽解析：不认文件名，认「这个槽位要什么角色」
//
// 为什么需要它：
//   模板（workflows/*.json）为了可复现，钉死了确切的模型文件名，例如 flux1-dev-Q4_K_S.gguf。
//   但别人机器上同一个模型可能叫 -fp16 / -int8、或被发布者改了名、或放在别的子目录。
//   结果：提交时抛一堆 node_errors，人以为是代码坏了。
//
// 这个模块只做**检测与建议**，不自动改写工作流：
//   换成错的模型比报"找不到"更糟 —— 所以最终换不换由人或 AI 明确决定，并记录替换事实。
//
// 三个状态：
//   ok         本机存在该文件
//   missing    不存在，且同角色目录里没有可替代候选
//   candidates 不存在，但同角色目录里有候选（给出列表与体积，供人挑）
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { COMFY_ROOT } from './config.mjs';

const GIB = 1024 ** 3;

/** 槽位 → 该去哪些 models 子目录找（顺序即优先级） */
export const SLOT_DIRS = {
  ckpt_name: ['checkpoints'],
  unet_name: ['unet', 'diffusion_models'],
  clip_name: ['clip', 'text_encoders'],
  clip_name1: ['clip', 'text_encoders'],
  clip_name2: ['clip', 'text_encoders'],
  vae_name: ['vae'],
  lora_name: ['loras'],
  model_name: ['latent_upscale_models', 'upscale_models'],
};

const MODEL_EXT = /\.(safetensors|gguf|ckpt|pt|pth|bin|onnx)$/i;

/** 列出某个 models 子目录下的模型文件（不递归太深） */
export function listModelsIn(dirNames, root = COMFY_ROOT) {
  if (!root) return [];
  const out = [];
  for (const d of dirNames) {
    const base = join(root, 'models', d);
    if (!existsSync(base)) continue;
    const walk = (p, depth) => {
      if (depth > 2) return;
      let names;
      try { names = readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of names) {
        const full = join(p, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (!MODEL_EXT.test(e.name)) continue;
        let sizeGb = 0;
        try { sizeGb = +(statSync(full).size / GIB).toFixed(2); } catch { /* ignore */ }
        out.push({ name: e.name, dir: d, sizeGb });
      }
    };
    walk(base, 0);
  }
  return out;
}

/** 取工作流里所有「模型槽位」：(节点, 输入键, 当前值) */
export function findModelSlots(workflow) {
  const slots = [];
  const g = workflow?.workflow && !workflow.nodes ? workflow.workflow : workflow;
  for (const [id, node] of Object.entries(g || {})) {
    const inputs = node?.inputs;
    if (!inputs || typeof inputs !== 'object') continue;
    for (const [key, val] of Object.entries(inputs)) {
      if (!SLOT_DIRS[key]) continue;
      if (typeof val !== 'string') continue; // 连线的槽位是数组，跳过
      slots.push({ id, class_type: node.class_type, key, value: val });
    }
  }
  return slots;
}

/**
 * 分析一个工作流的模型槽位。
 * @returns {{localReady:boolean, slots:Array, summary:{ok:number,missing:number,candidates:number}}}
 */
export function analyzeModelSlots(workflow, { root = COMFY_ROOT } = {}) {
  const slots = findModelSlots(workflow);
  const localReady = Boolean(root);
  const rows = slots.map((s) => {
    if (!localReady) return { ...s, status: 'unknown', reason: 'remote 模式（没有 comfyRoot），无法核对本地模型' };
    const dirs = SLOT_DIRS[s.key];
    // 1) 直接命中：文件是否就在它该在的目录里
    for (const d of dirs) {
      const p = join(root, 'models', d, s.value);
      if (existsSync(p)) {
        let sizeGb = 0;
        try { sizeGb = +(statSync(p).size / GIB).toFixed(2); } catch { /* ignore */ }
        return { ...s, status: 'ok', foundIn: d, sizeGb };
      }
    }
    // 2) 同名但整体搜一下（可能放错子目录）
    const all = listModelsIn(Object.keys(SLOT_DIRS).flatMap((k) => SLOT_DIRS[k]), root);
    const sameName = all.find((m) => m.name === s.value);
    if (sameName) {
      return { ...s, status: 'candidates', reason: `文件在 models/${sameName.dir}/，不在该槽位期望的 ${dirs.join(' 或 ')}`, candidates: [sameName] };
    }
    // 3) 给同角色候选：先按扩展名分组（.gguf 只配 .gguf，量化格式不能混），再按体积降序
    const ext = (s.value.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    const cands = listModelsIn(dirs, root)
      .sort((a, b) => {
        const ea = a.name.toLowerCase().endsWith(ext) ? 0 : 1;
        const eb = b.name.toLowerCase().endsWith(ext) ? 0 : 1;
        if (ea !== eb) return ea - eb;
        return b.sizeGb - a.sizeGb;
      })
      .filter((c) => c.name.toLowerCase().endsWith(ext)) // 只保留同格式，宁缺勿错
      .slice(0, 5);
    return {
      ...s,
      status: cands.length ? 'candidates' : 'missing',
      reason: cands.length ? '本机没有这个文件；同角色目录里有下列候选' : `models/${dirs.join('/ 或 ')} 里没有任何 ${Object.keys(SLOT_DIRS).includes(s.key) ? '模型' : '文件'}`,
      candidates: cands,
    };
  });

  const summary = { ok: 0, missing: 0, candidates: 0, unknown: 0 };
  for (const r of rows) summary[r.status] = (summary[r.status] || 0) + 1;
  return { localReady, slots: rows, summary };
}

/** 渲染成人读文本 */
export function formatSlotReport({ localReady, slots, summary }) {
  const lines = [];
  if (!localReady) {
    lines.push('⚠ remote 模式：没有 comfyRoot，无法核对本地模型文件。设 COMFY_ROOT 后重跑。');
    return lines.join('\n');
  }
  lines.push(`模型槽位 ${slots.length} 个：ok ${summary.ok} · 有候选 ${summary.candidates} · 缺失 ${summary.missing}`);
  for (const s of slots) {
    const head = `[${s.status}] ${s.class_type}(${s.id}).${s.key} = ${s.value}`;
    lines.push(head);
    if (s.reason) lines.push(`    ${s.reason}`);
    for (const c of s.candidates || []) lines.push(`    候选：${c.name}  (${c.sizeGb}GB, models/${c.dir}/)`);
  }
  if (summary.missing || summary.candidates) {
    lines.push('');
    lines.push('注意：换模型比缺模型更危险。确认要换再改，并把这个替换事实记录下来。');
  }
  return lines.join('\n');
}
