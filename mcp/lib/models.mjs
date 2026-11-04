// lib/models.mjs — 模型档案：原生分辨率、宽高比桶、可用性
// 分辨率不该由模板硬编码，而应由「用哪个模型」决定；这里把这条规则落成可改的 JSON。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './comfy.mjs';

const FILE = join(PROJECT_ROOT, 'models.json');

let _cache = null;

export function loadRegistry({ fresh = false } = {}) {
  if (_cache && !fresh) return _cache;
  if (!existsSync(FILE)) {
    _cache = { families: { unknown: { label: '未登记模型', native_mp: 1.0, buckets: [] } }, models: {} };
    return _cache;
  }
  _cache = JSON.parse(readFileSync(FILE, 'utf8'));
  return _cache;
}

export function saveRegistry(reg) {
  _cache = reg;
  writeFileSync(FILE, JSON.stringify(reg, null, 2), 'utf8');
  return { path: FILE };
}

/** 从文件名猜家族（用于没登记的新模型） */
export function guessFamily(file = '') {
  const s = String(file).toLowerCase();
  if (/flux/.test(s)) return 'flux';
  if (/pony|illustrious|noobai/.test(s)) return 'sdxl';
  if (/sd_?3|sd3/.test(s)) return 'sd3';
  if (/sdxl|xl_?refiner/.test(s)) return 'sdxl';
  if (/sd_?1[._-]?5|v1-5|sd15/.test(s)) return 'sd15';
  if (/hunyuan/.test(s)) return 'hunyuan_image';
  return 'unknown';
}

export function profileFor(modelFile) {
  const reg = loadRegistry();
  const entry = reg.models?.[modelFile];
  const family = entry?.family || guessFamily(modelFile);
  const fam = reg.families?.[family] || reg.families?.unknown || { native_mp: 1.0, buckets: [] };
  // 单个模型可以覆盖家族默认值：社区微调的 checkpoint 经常在比「家族原生」更大的图上训练，
  // 实测出来的最佳尺寸必须能写回这个模型本身，而不是被家族默认值盖掉（这是本轮实测发现的缺口）。
  const buckets = Array.isArray(entry?.buckets) && entry.buckets.length ? entry.buckets : (fam.buckets || []);
  return {
    model: modelFile,
    registered: !!entry,
    label: entry?.label || modelFile,
    family,
    family_label: fam.label || family,
    native_mp: entry?.native_mp ?? fam.native_mp ?? 1.0,
    buckets,
    steps: entry?.steps ?? fam.steps,
    cfg: entry?.cfg ?? fam.cfg,
    guidance: entry?.guidance ?? fam.guidance,
    sampler: entry?.sampler ?? fam.sampler,
    scheduler: entry?.scheduler ?? fam.scheduler,
    usable: entry?.usable !== false,
    reason: entry?.reason,
    note: entry?.note || fam.note,
  };
}

/** 按模型判断尺寸是否合适：是否命中桶、是否接近原生像素量 */
export function checkSize(modelFile, width, height) {
  const p = profileFor(modelFile);
  const w = Number(width), h = Number(height);
  const mp = (w * h) / 1e6;
  const warnings = [], errors = [], info = [];
  if (!p.usable) {
    errors.push(`${p.model} 不可用：${p.reason || '已被标记为不可用'}`);
    return { profile: p, width: w, height: h, mp, exact_bucket: false, warnings, errors, info };
  }
  const exact = (p.buckets || []).find(([bw, bh]) => bw === w && bh === h);
  if ((p.buckets || []).length) {
    if (exact) {
      info.push(`命中 ${p.family_label} 的推荐桶 ${w}x${h}（${mp.toFixed(2)}MP）`);
    } else {
      const near = (p.buckets || [])
        .map(([bw, bh]) => ({ bw, bh, d: Math.abs(bw - w) + Math.abs(bh - h) }))
        .sort((a, b) => a.d - b.d)[0];
      warnings.push(`${w}x${h} 不在 ${p.family_label} 的推荐桶里；最接近的是 ${near.bw}x${near.bh}。非桶尺寸容易构图失衡/重复肢体。`);
    }
  } else {
    info.push('该模型未登记宽高比桶，按模型卡自行确认。');
  }
  if (mp < p.native_mp * 0.5) {
    warnings.push(`${w}x${h}=${mp.toFixed(2)}MP，低于该模型原生 ${p.native_mp}MP 的一半，细节与结构都会明显变差。`);
  } else if (mp > p.native_mp * 1.6) {
    warnings.push(`${w}x${h}=${mp.toFixed(2)}MP，高于原生 ${p.native_mp}MP 的 1.6 倍，容易出现重复主体/拉长，且更吃显存。`);
  }
  const ar = w / h;
  if (ar > 2.2 || ar < 0.45) warnings.push(`宽高比 ${ar.toFixed(2)} 过于极端，模型没见过这种比例。`);
  return { profile: p, width: w, height: h, mp, exact_bucket: !!exact, warnings, errors, info };
}

/** 从 API 工作流里找出真正在用的模型文件名 */
export function modelFromWorkflow(wf) {
  for (const node of Object.values(wf || {})) {
    const t = node?.class_type;
    if (t === 'UnetLoaderGGUF' || t === 'UnetLoaderGGUFAdvanced' || t === 'UNETLoader') {
      return { file: node.inputs?.unet_name, kind: t };
    }
  }
  for (const node of Object.values(wf || {})) {
    if (node?.class_type === 'CheckpointLoaderSimple') {
      return { file: node.inputs?.ckpt_name, kind: 'CheckpointLoaderSimple' };
    }
  }
  return { file: null, kind: null };
}

export function listProfiles() {
  const reg = loadRegistry({ fresh: true });
  const models = Object.entries(reg.models || {}).map(([file, e]) => ({
    file,
    ...profileFor(file),
    usable: e.usable !== false,
    reason: e.reason,
  }));
  return { path: FILE, families: Object.keys(reg.families || {}), models };
}
