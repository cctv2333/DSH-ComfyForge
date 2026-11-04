// lib/modelfiles.mjs — 看模型文件的「真实身份」，判断它该放哪个目录
//
// 为什么需要：ComfyUI 的目录名和模型内容并不强绑定。最常见的事故是把「完整 checkpoint」
// 丢进 models/unet（UNETLoader 只认纯 unet 权重），于是加载节点列表里能看到、一跑就报错，
// 或者干脆看不到。这里只读文件头，不改文件：读 safetensors 的 JSON 头 / gguf 的魔数，
// 按张量名判断它到底是 checkpoint、纯 unet、VAE、文本编码器、LoRA 还是 ControlNet。
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { COMFY_ROOT } from './config.mjs';

const MODEL_EXT = /\.(safetensors|gguf|ckpt|pt|pth|bin)$/i;

// 目录 → 期望的模型类别（多余类别会给「放错」建议）
const EXPECTED = {
  checkpoints: ['checkpoint'],
  diffusion_models: ['unet'],
  unet: ['unet'],
  vae: ['vae'],
  clip: ['text_encoder'],
  text_encoders: ['text_encoder'],
  loras: ['lora'],
  controlnet: ['controlnet', 'unet'],
  upscale_models: ['upscaler'],
  latent_upscale_models: ['upscaler'],
  embeddings: ['embedding'],
};

const MAX_HEADER = 16 * 1024 * 1024;

function readSafetensorsKeys(path) {
  const fd = openSync(path, 'r');
  try {
    const sizeBuf = Buffer.alloc(8);
    readSync(fd, sizeBuf, 0, 8, 0);
    const len = Number(sizeBuf.readBigUInt64LE(0));
    if (!Number.isFinite(len) || len <= 1 || len > MAX_HEADER) return null;
    const head = Buffer.alloc(len);
    readSync(fd, head, 0, len, 8);
    const j = JSON.parse(head.toString('utf8'));
    return Object.keys(j).filter((k) => k !== '__metadata__');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** 按张量名/魔数判断模型类别与家族（只看名字，不加载权重） */
export function classifyModelFile(path) {
  const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (ext === 'gguf') return { kind: 'unet', family: 'flux-or-sdxl-gguf', evidence: 'GGUF 权重（通常是 unet）' };
  if (ext === 'ckpt' || ext === 'pt' || ext === 'pth' || ext === 'bin') {
    return { kind: 'checkpoint', family: 'legacy', evidence: '旧式权重文件（多为完整 checkpoint）' };
  }
  const keys = readSafetensorsKeys(path);
  if (!keys) return { kind: 'unknown', family: null, evidence: '读不出 safetensors 头' };

  const has = (s) => keys.some((k) => k.includes(s));
  const hasPrefix = (s) => keys.some((k) => k.startsWith(s));
  const count = (s) => keys.filter((k) => k.includes(s)).length;

  const isCkpt = hasPrefix('cond_stage_model') && hasPrefix('first_stage_model') && has('model.diffusion_model');
  const isUnetOnly = (hasPrefix('model.diffusion_model') || has('input_blocks') || has('double_blocks')) && !hasPrefix('cond_stage_model');
  const isLora = has('lora_unet') || has('lora_te') || has('lora.down') || hasPrefix('lora_');
  // VAE 用「量化卷积/解码器起始层」判断，不能只看 encoder.* —— T5 的权重也叫 encoder.block.*
  const isVae = has('post_quant_conv') || has('quant_conv') || hasPrefix('decoder.conv_in') || hasPrefix('encoder.conv_in');
  // ControlNet 的特征是 control 专用分支（FLUX Union 用的是 controlnet_blocks / context_embedder）
  const isCn = has('control_model') || has('input_hint_block') || has('zero_convs')
    || has('controlnet_blocks') || has('controlnet_down_blocks') || has('controlnet_cond_embedding');
  const isClip = hasPrefix('text_model') || has('text_projection') || has('token_embedding')
    || hasPrefix('encoder.block') || has('shared.weight');
  // latent 放大网络（H3 latent upscaler / NNLatentUpscale 一类）：没有 VAE 的 quant_conv，
  // 主干是 in_blocks/out_blocks 残差块 + conv_in/conv_out（3D 版再加 temporal）
  const isLatentUpscaler = hasPrefix('in_blocks') && hasPrefix('out_blocks') && hasPrefix('conv_in');

  let family = null;
  if (has('double_blocks')) family = 'flux';
  else if (has('label_emb') || has('conditioner.embedders')) family = 'sdxl';
  else if (isCkpt || isUnetOnly) family = 'sd15-or-sd21';

  let kind = 'unknown';
  if (isLora) kind = 'lora';
  else if (isCn) kind = 'controlnet';
  else if (isCkpt) kind = 'checkpoint';
  else if (isUnetOnly) kind = 'unet';
  else if (isLatentUpscaler) kind = 'upscaler';
  else if (isClip && !isVae) kind = 'text_encoder';
  else if (isVae) kind = 'vae';

  return {
    kind, family,
    evidence: `张量 ${keys.length} 个：cond_stage_model=${hasPrefix('cond_stage_model')}，first_stage_model=${hasPrefix('first_stage_model')}，double_blocks=${count('double_blocks')}，label_emb=${count('label_emb')}`,
  };
}

/** 扫描 models/ 下主要目录，给出「放对了吗」的清单 */
export function auditModels() {
  if (!COMFY_ROOT) return { ok: false, error: '没有 ComfyUI 目录（remote 模式）' };
  const root = join(COMFY_ROOT, 'models');
  if (!existsSync(root)) return { ok: false, error: `没有 ${root}` };
  const rows = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const expect = EXPECTED[dir.name];
    if (!expect) continue;
    const abs = join(root, dir.name);
    for (const f of readdirSync(abs)) {
      if (!MODEL_EXT.test(f)) continue;
      const p = join(abs, f);
      let size = 0;
      try { size = statSync(p).size; } catch { continue; }
      const c = classifyModelFile(p);
      const ok = c.kind === 'unknown' ? null : expect.includes(c.kind);
      rows.push({
        file: `models/${dir.name}/${f}`,
        size_gb: +(size / 1073741824).toFixed(2),
        dir: dir.name, detected: c.kind, family: c.family,
        ok,
        advice: ok === true ? null
          : ok === null ? '认不出类型：确认它是给哪个加载节点用的'
            : `它在 ${dir.name}/，但这个目录只接受 ${expect.join('/')}；放到 ${suggestDir(c.kind)}/ 才能被对应加载节点看到`,
        evidence: c.evidence,
      });
    }
  }
  const wrong = rows.filter((r) => r.ok === false);
  return {
    ok: true,
    scanned: rows.length,
    misplaced: wrong.length,
    rows,
    hint: wrong.length
      ? '放错的文件不会被对应的加载节点看到（或加载时报权重不匹配）。只读检查，不改文件；需要移动请自己动手或用 extra_model_paths.yaml。'
      : '目录与内容一致。',
  };
}

function suggestDir(kind) {
  const map = {
    checkpoint: 'checkpoints', unet: 'diffusion_models（或 unet）', vae: 'vae',
    text_encoder: 'text_encoders（或 clip）', lora: 'loras', controlnet: 'controlnet', upscaler: 'upscale_models',
  };
  return map[kind] || '对应的模型目录';
}
