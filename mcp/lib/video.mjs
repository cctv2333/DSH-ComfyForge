// lib/video.mjs — MiniMax H3 图生视频（本机实测过的参数组合）
//
// 背景（2026-11-04 实测，RTX 5060 Ti 8GB）：
//   * 124 帧 @1280x736、8 步 ≈ 9.5 分钟；362 帧一次性生成会 OOM；
//   * length 必须满足 5 + 17k（H3 的时序压缩步长）；
//   * 宽高必须是 32 的倍数；
//   * 二采（latent 放大）在 0.30.2 上对 I2V 不可用（NestedTensor 不兼容），
//     0.44 之后有核心节点 MiniMaxH3LatentUpscaleWithModel 再启用。
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  OUTPUT_DIR, PROJECT_ROOT, COMFY_ROOT, FFMPEG, submit, waitFor, parseHistoryEntry, localOutputPath,
} from './comfy.mjs';
import { validateH3Prompt, formatH3Problems } from './h3protocol.mjs';

export const FPS = 24;

/**
 * 提示词结构没通过时抛这个。
 * 为什么不交给 ComfyUI 报错：POST /prompt 只校验节点/必填/类型，提示词写错它一句话不说，
 * 只会跑几分钟给你一条跑偏的片子。所以在**提交前**拦住，并且只报结构、不回灌正文。
 */
export class H3PromptCheckError extends Error {
  constructor(result) {
    const errors = result.problems.filter((p) => p.level === 'error');
    super(`H3 提示词结构没通过（${errors.length} 项）：\n${formatH3Problems(result.problems)}`);
    this.name = 'H3PromptCheckError';
    this.problems = result.problems;
    this.mode = result.mode;
  }
}


/** 秒 → H3 合法帧数（5 + 17k），并给出实际时长 */
export function framesFor(seconds) {
  const raw = Math.max(5, Math.round(seconds * FPS));
  const frames = raw + ((5 - (raw % 17)) % 17);
  return { frames, seconds: +(frames / FPS).toFixed(3) };
}

// 默认模型文件名。不同机器上同名模型可能叫别的名字（-fp16 / -int8 / 发布者改名），
// 所以每个都能用环境变量覆盖；找不到时 modelslots 会给出候选，别硬改代码。
const envOr = (k, d) => process.env[k] || d;
const MODELS = {
  unet: envOr('COMFYFORGE_H3_UNET', 'DasiwaMinimaxH3_dasiwaHybridV2_int8.safetensors'),
  lora: envOr('COMFYFORGE_H3_LORA', 'TaoMate-H3-3step.safetensors'),
  clip: envOr('COMFYFORGE_H3_CLIP', 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors'),
  vae: envOr('COMFYFORGE_H3_VAE', 'minimax_h3_video_vae_fp16.safetensors'),
  audioVae: envOr('COMFYFORGE_H3_AUDIO_VAE', 'minimax_h3_audio_vae_fp32.safetensors'),
};

/**
 * 组装 H3 图生视频的 API 工作流（单遍）。
 * @param {object} o
 * @param {string} o.image      ComfyUI input 目录里的文件名
 * @param {string} o.prompt
 * @param {number} o.width      生成宽（32 倍数）
 * @param {number} o.height     生成高（32 倍数）
 * @param {number} o.length     帧数（会用 framesFor 校正）
 * @param {number} o.steps
 * @param {number} o.seed
 * @param {number} [o.outW]     输出宽（默认同 width）
 * @param {number} [o.outH]     输出高（默认同 height）
 * @param {'disabled'|'center'} [o.crop]
 * @param {string} o.prefix
 */
export function buildH3Workflow(o) {
  const { frames } = framesFor(o.seconds ?? (o.length / FPS));
  const length = o.length ?? frames;
  const w = o.width ?? 1280;
  const h = o.height ?? 736;
  const props = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: o.unet ?? MODELS.unet, weight_dtype: 'default' } },
    '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: o.lora ?? MODELS.lora, strength_model: o.loraStrength ?? 1.0 } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: MODELS.clip, type: 'minimax', device: 'default' } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: MODELS.vae } },
    '5': { class_type: 'LoadImage', inputs: { image: o.image } },
  };
  // 闭环：同一张图同时当首帧和尾帧，模型会被推着回到起点（做无缝循环的基础）
  if (o.lastImage) props['17'] = { class_type: 'LoadImage', inputs: { image: o.lastImage } };
  props['6'] = {
    class_type: 'MiniMaxH3ImageToVideo',
    inputs: {
      clip: ['3', 0], vae: ['4', 0], prompt: o.prompt,
      width: w, height: h, length,
      first_frame: ['5', 0],
      ...(o.lastImage ? { last_frame: ['17', 0] } : {}),
    },
  };
  Object.assign(props, {
    '7': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['2', 0], shift_video: o.shiftVideo ?? 12.0, shift_audio: o.shiftAudio ?? 3.0 } },
    '8': { class_type: 'BasicGuider', inputs: { model: ['7', 0], conditioning: ['6', 0] } },
    '9': { class_type: 'RandomNoise', inputs: { noise_seed: o.seed ?? 0 } },
    '10': { class_type: 'KSamplerSelect', inputs: { sampler_name: o.sampler ?? 'res_multistep' } },
    '11': { class_type: 'BasicScheduler', inputs: { model: ['7', 0], scheduler: 'simple', steps: o.steps ?? 8, denoise: 1.0 } },
    '12': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['9', 0], guider: ['8', 0], sampler: ['10', 0], sigmas: ['11', 0], latent_image: ['6', 1] } },
    '13': { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['4', 0] } },
    '15': {
      class_type: 'ImageScale',
      inputs: { image: ['13', 0], upscale_method: 'lanczos', width: o.outW ?? w, height: o.outH ?? h, crop: o.crop ?? 'disabled' },
    },
    '14': {
      class_type: 'VHS_VideoCombine',
      inputs: {
        images: ['15', 0], frame_rate: FPS, loop_count: 0, filename_prefix: o.prefix ?? 'comfyforge/video',
        format: o.format ?? 'video/h264-mp4', pingpong: false, save_output: true,
      },
    },
  });

  // H3 是音视频模型：同一个 latent 里还有一条音轨。默认解出来一起封装；
  // 音频解码失败时（节点/VAE 不在），把 audio 摘掉重试即可，不影响视频。
  if (o.audio !== false) {
    props['31'] = { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } };
    props['32'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['12', 0], vae: ['31', 0] } };
    props['14'].inputs.audio = ['32', 0];
  }

  return props;
}

/**
 * 组装 H3 **r2v 二采** 的 API 工作流（参考工作流同构）。
 *
 * 链路（2026-11-04 实测：先按参考工作流的 SplitSigmas 路复现，出碎片；改成下面的
 * 「跑满 → 放大 → 独立低噪声短曲线」后干净）：
 *   r2v 在 W×H 上跑满 steps 步（**必须跑满**，见下）
 *   → 拆 AV latent → 学习型 3D 放大 ×scale（音频原样穿过）→ 拼回
 *   → MMH3UltimateUpscale 用一条新的短曲线（refineSteps / refineDenoise）按 chunk 分块重采样
 *   → 解码视频 + 音频 → 混流
 *
 * 三条硬约束（错了就出碎片/散架）：
 *   1. 一采必须跑满 sigma。学习型放大网络按干净 latent 归一化，喂中途 latent 只会放大噪声。
 *   2. 两遍共用同一个 RandomNoise（同 seed），二采不是"重新抽一次"。
 *   3. 二采不要吃 SplitSigmas 的后半段（参考工作流那样写实测出碎片，见 splitSigmas 分支注释）。
 *
 * @param {object} o
 * @param {string} o.image        参考图（ComfyUI input 目录内文件名）
 * @param {string} o.prompt
 * @param {number} [o.width]      一采宽（32 倍数，默认 608）
 * @param {number} [o.height]     一采高（32 倍数，默认 352）
 * @param {number} [o.length]     帧数（5+17k）
 * @param {number} [o.steps]      总步数，默认 12
 * @param {number} [o.splitStep]  一采步数（SplitSigmas step），默认 8
 * @param {number} [o.scale]      放大倍数，默认 2
 * @param {number} [o.chunk]      MMH3 时间块（17 的倍数），默认 153
 * @param {number} [o.overlap]    块重叠（17 的倍数），默认 17
 * @param {number} [o.anchor]     frame-0 锚强度，默认 0.99
 * @param {boolean} [o.audio]     是否混音轨，默认 true
 */
export function buildH3Pass2Workflow(o) {
  const w = o.width ?? 608;
  const h = o.height ?? 352;
  const scale = o.scale ?? 2;
  const steps = o.steps ?? 12;
  const splitStep = o.splitStep ?? 8;
  if (w % 32 || h % 32) throw new Error(`一采宽高必须是 32 的倍数：${w}x${h}`);
  // 走"独立短曲线"二采（会重新加噪）的唯一条件：调用者显式给了 refine 参数。
  // 默认走 SplitSigmas 8+4——σ 连续下降一次，音频才不会被重采样毁掉。
  const independentRefine = o.refineSteps != null || o.refineDenoise != null;
  if (!independentRefine && splitStep >= steps) throw new Error(`splitStep(${splitStep}) 必须小于 steps(${steps})，否则二采没有 sigma 可跑`);
  const upW = Math.round(w * scale / 32) * 32;
  const upH = Math.round(h * scale / 32) * 32;
  const chunk = o.chunk ?? 153;
  const overlap = o.overlap ?? 17;
  if (chunk % 17 || overlap % 17) throw new Error(`chunk/overlap 必须是 17 的倍数：${chunk}/${overlap}`);

  const props = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: o.unet ?? MODELS.unet, weight_dtype: 'default' } },
    '2': {
      class_type: 'ModelAttentionBackend',
      inputs: { model: ['1', 0], attention: o.attention ?? 'comfy kitchen attention' },
    },
    // attention=false 时整条后端节点不接（排障用：把它当成可疑项单独拿掉）
    '3': { class_type: 'LoraLoaderModelOnly', inputs: { model: o.attention === false ? ['1', 0] : ['2', 0], lora_name: o.lora ?? MODELS.lora, strength_model: o.loraStrength ?? 1.0 } },
    '4': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['3', 0], shift_video: o.shiftVideo ?? 12.0, shift_audio: o.shiftAudio ?? 3.0 } },
    '5': { class_type: 'CLIPLoader', inputs: { clip_name: MODELS.clip, type: 'minimax', device: 'default' } },
    '6': { class_type: 'VAELoader', inputs: { vae_name: MODELS.vae } },
    '7': { class_type: 'VAELoader', inputs: { vae_name: MODELS.audioVae } },
    '8': { class_type: 'LoadImage', inputs: { image: o.image } },
    '9': {
      class_type: 'MiniMaxH3ReferenceToVideo',
      inputs: {
        clip: ['5', 0], vae: ['6', 0], audio_vae: ['7', 0],
        prompt: o.prompt, width: w, height: h, length: o.length,
        ref_image_size: o.refImageSize ?? 'match',
        'ref_images.ref_image_0': ['8', 0],
      },
    },
    '10': { class_type: 'RandomNoise', inputs: { noise_seed: o.seed ?? 0 } },
    '11': { class_type: 'KSamplerSelect', inputs: { sampler_name: o.sampler ?? 'res_multistep' } },
    '12': { class_type: 'BasicScheduler', inputs: { model: ['4', 0], scheduler: o.scheduler ?? 'simple', steps, denoise: 1.0 } },
    '13': { class_type: 'SplitSigmas', inputs: { sigmas: ['12', 0], step: splitStep } },
    // 一采：前 splitStep 步
    '14': { class_type: 'BasicGuider', inputs: { model: ['4', 0], conditioning: ['9', 0] } },
    '15': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['10', 0], guider: ['14', 0], sampler: ['11', 0], sigmas: ['13', 0], latent_image: ['9', 1] } },
    // 放大：拆 AV → 3D 学习型放大（只动视频）→ 拼回
    // 取 denoised_output（[1]）而不是 output（[0]）：一采只跑 8 步时 output 仍是
  // σ≈0.6 的半成品，3D 放大网络按干净 latent 的统计做归一化，喂半成品会放大成
  // 彩色碎片（实测 704×1216 满屏方块+白色锯齿轮廓）。用户的参考工作流一直取 [1]。
  '16': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['15', 1] } },
    '17': {
      class_type: 'MinimaxH3LatentUpscaler3D',
      inputs: {
        latent: ['16', 0], model_name: o.upscaler ?? 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
        mode: 'scale by multiplier', 'mode.scale': scale, align: 32,
        enable_temporal_chunking: o.upscalerChunking ?? true, force_unload: true,
        device: 'cuda', precision: o.upscalerPrecision ?? 'fp16',
      },
    },
    '18': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['17', 0], audio_latent: ['16', 1] } },
    // 二采：同一条 sigma 的后半段 + 分块重采样
    '19': { class_type: 'MMH3TemporalSplitParams', inputs: { chunk_length: chunk, temporal_overlap: overlap, anchor_strength: o.anchor ?? 0.99 } },
    '20': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['9', 0] } },
    '21': {
      class_type: 'MMH3UltimateUpscale',
      inputs: {
        model: ['4', 0], conditioning: ['9', 0], latent: ['18', 0],
        noise: ['10', 0], sampler: ['11', 0], sigmas: ['13', 1],
        negative: ['20', 0], cfg: o.cfg ?? 1.0, temporal_split_param: ['19', 0],
      },
    },
    '22': { class_type: 'VAEDecode', inputs: { samples: ['21', 0], vae: ['6', 0] } },
  };

  // ── 二采的两条路线（2026-11-06 重新实测，124 帧 / 352×608 → 704×1216）──
  //
  // 【默认 · 正确】splitSigmas=true：一采只跑前 splitStep 步 → 放大 →
  //   二采吃**同一条曲线**的后半段（SplitSigmas 的 low）。σ 从 1.0 连续降到 0，
  //   全程只降一次噪。
  //
  // 【可选 · 会毁音频】独立短曲线：一采跑满 steps → 放大 →
  //   二采另起 BasicScheduler(steps=refineSteps, denoise=refineDenoise)，
  //   即**重新注入 35% 噪声再降一次**。视频扛得住（甚至更锐），
  //   **但音频 latent 也被一起加噪重采，audio VAE 解出来是纯谐波嗡鸣。**
  //   实测对比（同一提示词/seed/参考图，只改这条路）：
  //     独立短曲线  → 过零率 0.021，频谱是平行横线（1230Hz 整数倍谐波）
  //     SplitSigmas → 过零率 0.063，频谱有瞬态、全频带铺开
  //   要让用户自己选这条路，必须显式传 refineSteps 或 refineDenoise。
  //
  // 历史更正（BUG-0030 → 本条）：2026-11-04 曾断言"splitSigmas 实测出碎片，别用"。
  //   2026-11-06 用 124 帧 + 同一套 UNET/res_multistep/shift 12:3/scale 2 重测，
  //   **画面正常、音频正常，没有碎片**。旧结论来自当时那套组合（39 帧、
  //   不同采样器），不能归因于 splitSigmas 本身——和 BUG-0030 是同一个错误。
  const wantsIndependentRefine = independentRefine;
  if (wantsIndependentRefine) {
    props['15'].inputs.sigmas = ['12', 0];
    props['30'] = {
      class_type: 'BasicScheduler',
      inputs: { model: ['4', 0], scheduler: o.scheduler ?? 'simple', steps: o.refineSteps ?? 4, denoise: o.refineDenoise ?? 0.35 },
    };
    props['21'].inputs.sigmas = ['30', 0];
  } else {
    props['15'].inputs.sigmas = ['13', 0];
    props['21'].inputs.sigmas = ['13', 1];
  }

  if (o.audio !== false) {
    props['23'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['21', 0], vae: ['7', 0] } };
  }
  props['24'] = {
    class_type: 'VHS_VideoCombine',
    inputs: {
      images: ['22', 0], frame_rate: FPS, loop_count: 0,
      filename_prefix: o.prefix ?? 'comfyforge/h3-2pass',
      format: o.format ?? 'video/h264-mp4', pingpong: false, save_output: true,
      ...(o.audio !== false ? { audio: ['23', 0] } : {}),
    },
  };

  // 只跑一采（不放大、不二采），用于对照"一采本身是否干净"。
  // 注意：必须吃**完整** sigma 曲线（跑满 steps），否则解的是中途 latent，出来必然是块状马赛克。
  if (o.pass1Only) {
    props['15'] = {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['10', 0], guider: ['14', 0], sampler: ['11', 0], sigmas: ['12', 0], latent_image: ['9', 1] },
    };
    props['22'] = { class_type: 'VAEDecode', inputs: { samples: ['15', 1], vae: ['6', 0] } };
    if (o.audio !== false) props['23'].inputs.samples = ['15', 1];
  }

  return {
    workflow: props,
    meta: {
      width: w, height: h, upW, upH, steps,
      splitStep: independentRefine ? null : splitStep,
      splitSigmas: !independentRefine,
      refine: independentRefine ? { steps: o.refineSteps ?? 4, denoise: o.refineDenoise ?? 0.35 } : null,
      // 这一行是给调用方和用户看的：走独立短曲线时音频会退化成谐波（实测过零率 0.021 vs 0.063）
      audioRisk: independentRefine
        ? '二采用独立短曲线（重新加噪 35%），音频 latent 被一起重采样，实测退化成谐波嗡鸣。要音频请去掉 refineSteps/refineDenoise，走 SplitSigmas 路径。'
        : null,
      scale, chunk, overlap,
    },
  };
}

/** 提交视频任务；返回 prompt_id 与"这一单的实际参数"
 *  mode: 'single'（i2v 单遍）| '2pass'（r2v + 学习型 3D 放大 + 分块二采） */
export async function startVideo(o) {
  const mode = o.mode ?? 'single';

  // 提交前先过一遍结构校验。拦的是 error 级（结构确定不对），warn 只随结果带回来。
  // 想跳过：显式传 allowInvalidPrompt: true（用于对照实验/复刻旧稿）。
  const durationSec = o.seconds ?? (o.length ? o.length / FPS : undefined);
  const check = validateH3Prompt(o.prompt, { durationSec });
  if (!check.ok && !o.allowInvalidPrompt) throw new H3PromptCheckError(check);
  const promptWarnings = check.problems.filter((p) => p.level === 'warn');
  const promptNote = {
    promptMode: check.mode,
    ...(promptWarnings.length ? { promptWarnings: promptWarnings.slice(0, 8).map((p) => `${p.where}：${p.message}`) } : {}),
  };

  if (mode === '2pass') {
    const { frames } = framesFor(o.seconds ?? (o.length / FPS));
    const length = o.length ?? frames;
    const { workflow, meta } = buildH3Pass2Workflow({ ...o, length });
    const res = await submit(workflow, { clientId: 'comfyforge-video-2pass' });
    const hop = meta.chunk - meta.overlap;
    const chunkCount = length <= meta.chunk ? 1 : 1 + Math.ceil((length - meta.chunk) / hop);
    return {
      promptId: res.prompt_id,
      queued: res.number ?? null,
      mode,
      params: {
        ...meta, ...promptNote, frames: length, seconds: +(length / FPS).toFixed(2),
        seed: o.seed ?? 0, chunkCount,
      },
    };
  }
  const wf = buildH3Workflow(o);
  const { frames } = framesFor(o.seconds ?? (o.length / FPS));
  const res = await submit(wf, { clientId: 'comfyforge-video' });
  return {
    promptId: res.prompt_id,
    queued: res.number ?? null,
    mode: 'single',
    params: {
      ...promptNote,
      width: o.width ?? 1280, height: o.height ?? 736,
      frames, seconds: +(frames / FPS).toFixed(2), steps: o.steps ?? 8, seed: o.seed ?? 0,
    },
  };
}

/** 查一次状态（长任务用：一次等一小段，pending 就再调） */
export async function videoStatus(promptId, { waitS = 45 } = {}) {
  const r = await waitFor(promptId, { timeoutS: waitS });
  if (r.pending) return { pending: true, elapsedMs: r.elapsedMs, queue: r.queue };
  const p = parseHistoryEntry(r.entry);
  const files = [];
  for (const item of p.images) {
    if (/\.(mp4|webm|gif|webp)$/i.test(item.filename)) files.push(item);
  }
  for (const o of p.other) {
    if (!['gifs', 'videos'].includes(o.kind)) continue;
    for (const it of o.items || []) files.push({ ...it, subfolder: it.subfolder || '' });
  }
  const out = files.map((f) => ({ ...f, localPath: localOutputPath(f) }));
  return { pending: false, status: p.status, errors: p.errors, files: out, elapsedMs: r.elapsedMs };
}

/**
 * ffmpeg 位置：本地配置 / 环境变量 > 仓库内 tools/bin > ComfyUI 便携包同级 > PATH。
 *
 * 2026-11-07 的教训：为了去掉写死的本机路径，我先改成"只查 PATH"，
 * 结果这台机器的 PATH 里没有 ffmpeg，抽帧/度量全报 spawnSync ENOENT。
 * **去硬编码 ≠ 只靠 PATH**：机器相关的值进 comfyforge.config.json（不入库），
 * 源码里只保留探测顺序和可读的报错。
 */
export function ffmpegBin() {
  return FFMPEG || 'ffmpeg';
}

/** 调 ffmpeg 前统一走这里：找不到时给人话，而不是 spawnSync ENOENT */
export function runFfmpeg(args, opts = {}) {
  const bin = ffmpegBin();
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error(
      `找不到 ffmpeg（试过 "${bin}" 和 PATH）。修法二选一：\n`
      + '  1) 在本机 comfyforge.config.json 里写 {"ffmpegPath": "<ffmpeg.exe 的绝对路径>"}\n'
      + '  2) 设环境变量 FFMPEG_PATH 指向 ffmpeg.exe\n'
      + '（那个配置文件在 .gitignore 里，属于本机设置，不会被提交。）',
    );
  }
  return r;
}

/** 按时间点抽帧（每点一张 PNG），返回可读路径列表 */
export function extractFrames(videoPath, { times = [], outDir, width = 1280 } = {}) {
  const dir = outDir || join(PROJECT_ROOT, '.cache', 'video-frames');
  mkdirSync(dir, { recursive: true });
  const base = stripExt(videoPath);
  const made = [];
  for (const t of times) {
    const out = join(dir, `${base}_t${String(t).replace('.', '_')}.png`);
    const r = spawnSync(ffmpegBin(), ['-y', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-vf', `scale=${width}:-1`, out], {
      encoding: 'utf8', timeout: 60000,
    });
    if (r.status === 0 && existsSync(out)) made.push({ t, path: out });
  }
  return made;
}

/** 用 ffmpeg -i 的 stderr 读时长（没有 ffprobe 也能用） */export function probeDuration(videoPath) {
  const r = spawnSync(ffmpegBin(), ['-i', videoPath], { encoding: 'utf8', timeout: 30000 });
  const txt = String(r.stderr || '');
  const m = txt.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

/** 生成时间码拼图（网格 = cols x rows，帧率按视频时长自动算，保证填满） */
export function makeVideoSheet(videoPath, { cols = 5, rows = 3, outDir } = {}) {
  const dir = outDir || join(PROJECT_ROOT, '.cache', 'sheets');
  mkdirSync(dir, { recursive: true });
  const dur = probeDuration(videoPath) || 5;
  const fps = Math.max(0.2, (cols * rows) / Math.max(0.2, dur));
  const out = join(dir, `${stripExt(videoPath)}_sheet_${Date.now()}.png`);
  const filter = `fps=${fps.toFixed(3)},scale=420:-1,tile=${cols}x${rows}`;
  const r = spawnSync(ffmpegBin(), ['-y', '-i', videoPath, '-vf', filter, '-frames:v', '1', out], {
    encoding: 'utf8', timeout: 120000,
  });
  if (r.status !== 0 || !existsSync(out)) {
    return { ok: false, error: (r.stderr || '').split('\n').slice(-3).join(' ') || 'ffmpeg failed' };
  }
  return { ok: true, path: out, fps: +fps.toFixed(3), duration: +dur.toFixed(2) };
}

/**
 * 视频客观指标（抽卡排序 / 二采前后对比用）。全部走 ffmpeg，不引入依赖。
 *
 * 返回：
 *   duration / fps / width / height / hasAudio / loudnessDb
 *   flicker      连续帧平均亮度差（0–255 尺度的 YAVG 差）——越大越闪
 *   flickerNoCut **剔除切点前后 2 帧后的同口径值**；跨镜头数比较只能用这个
 *   flickerMax   最差的那一对相邻帧
 *   blackRuns    黑帧段数（blackdetect）
 *   cuts         强切点个数（scene > 0.4）——分镜设计上是好事，意外切点是坏事
 *   cutTimes     切点时间（秒）
 *   score        越小越"稳"的排序分（只用于挑种子，不是画质评分）
 *
 * 为什么要有 flickerNoCut：切点那一帧的差分天然极大（实测 max 60+），
 * 所以"6 镜的片子"flicker 必然高于"1 镜到底"，跟画面稳不稳没关系。
 * 用它排序会系统性压分多镜头候选。所有排序口径都应改用 flickerNoCut。
 */
export function videoMetrics(videoPath) {
  const bin = ffmpegBin();
  const out = { path: videoPath, duration: probeDuration(videoPath) };

  // 时长/分辨率/帧率/音轨
  const probe = spawnSync(bin, ['-i', videoPath], { encoding: 'utf8', timeout: 30000 });
  const txt = String(probe.stderr || '');
  const vs = txt.match(/Video:\s*([\w-]+).*?(\d{2,5})x(\d{2,5})/);
  if (vs) { out.codec = vs[1]; out.width = +vs[2]; out.height = +vs[3]; }
  const fr = txt.match(/([\d.]+)\s+fps/);
  if (fr) out.fps = +fr[1];
  out.hasAudio = /Audio:\s*/.test(txt);
  out.sizeBytes = existsSync(videoPath) ? statSync(videoPath).size : null;

  // 帧间差分（tblend=difference 后取每帧 YAVG）
  const diffRun = spawnSync(bin, [
    '-i', videoPath, '-an',
    '-vf', 'tblend=all_mode=difference,signalstats,metadata=print:file=-',
    '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
  const diffs = [...String(diffRun.stdout || '').matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => +m[1]);
  if (diffs.length) {
    const sorted = [...diffs].sort((a, b) => a - b);
    const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
    out.flicker = +mean.toFixed(3);
    out.flickerP95 = +sorted[Math.floor(sorted.length * 0.95)].toFixed(3);
    out.flickerMax = +Math.max(...diffs).toFixed(3);
    out.samples = diffs.length;
  }

  // 逐帧 (时间, 差分) —— metadata=print 每帧一个块，pts_time 在前、YAVG 在后，按出现顺序配对
  const diffPairs = [];
  for (const block of String(diffRun.stdout || '').split(/frame:/).slice(1)) {
    const t = block.match(/pts_time:([\d.]+)/);
    const y = block.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    if (t && y) diffPairs.push({ t: +t[1], d: +y[1] });
  }

  // 黑帧
  const blackRun = spawnSync(bin, ['-i', videoPath, '-vf', 'blackdetect=d=0.08:pix_th=0.10', '-f', 'null', '-'], {
    encoding: 'utf8', timeout: 180000,
  });
  out.blackRuns = [...String(blackRun.stderr || '').matchAll(/black_start:([\d.]+)/g)].length;

  // 强切点
  const cutRun = spawnSync(bin, [
    '-i', videoPath, '-an', '-vf', "select='gt(scene,0.4)',metadata=print:file=-", '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
  out.cuts = [...String(cutRun.stdout || '').matchAll(/lavfi\.scene_score=/g)].length;
  const cutTimes = [...String(cutRun.stdout || '').matchAll(/pts_time:([\d.]+)/g)].map((m) => +m[1]);
  out.cutTimes = cutTimes.map((t) => +t.toFixed(3));

  // 剔除切点前后 2 帧再算一次 —— 跨镜头数比较只能用这个口径
  if (diffPairs.length && out.flicker != null) {
    const fps = out.fps || 24;
    const guard = (2 / fps) + 1e-6;
    const near = (t) => cutTimes.some((c) => Math.abs(t - c) <= guard);
    const kept = diffPairs.filter((p) => !near(p.t)).map((p) => p.d);
    if (kept.length >= Math.min(8, diffPairs.length / 2)) {
      out.flickerNoCut = +(kept.reduce((s, v) => s + v, 0) / kept.length).toFixed(3);
      out.flickerSamplesNoCut = kept.length;
    } else {
      out.flickerNoCut = null; // 切点太密，剔完没剩多少帧 —— 如实说"算不出来"
    }
  } else if (out.flicker != null) {
    out.flickerNoCut = out.flicker; // 解析不到逐帧时间戳时退化：没有切点信息可剔
  }

  // 音量（有音轨时）
  if (out.hasAudio) {
    const vol = spawnSync(bin, ['-i', videoPath, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60000 });
    const m = String(vol.stderr || '').match(/mean_volume:\s*(-?[\d.]+) dB/);
    if (m) out.loudnessDb = +m[1];
  }

  // 排序分：闪 + 黑帧 + 音量过低 都要扣；切点不算错（分镜本来就有切）
  // 用 flickerNoCut 而不是 flicker —— 否则多镜头候选会被系统性压分
  const f = out.flickerNoCut ?? out.flicker ?? 99;
  out.score = +(f + (out.blackRuns || 0) * 5 + (out.hasAudio && (out.loudnessDb ?? 0) < -40 ? 3 : 0)).toFixed(3);
  out.scoreBasis = out.flickerNoCut != null ? 'flickerNoCut' : 'flicker';
  return out;
}

function stripExt(p) {
  return String(p).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
}
