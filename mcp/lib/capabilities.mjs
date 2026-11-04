// lib/capabilities.mjs — 能力清单：这台机器现在能做什么、缺什么、补它要付多少代价
//
// 设计原则（回应「不要变成插件收集器」）：
//   1. 只读，不下载、不安装、不改任何东西；
//   2. 每条能力都给出「现在能不能做」+「缺的那一块具体是什么」+「补上要多大」；
//   3. 不推荐装一堆插件——先说明「不装也能做到什么」，再给「装了能多什么」。
//
// 判据只用三样可核实的东西：object_info 里的节点、custom_nodes 目录、models 目录里的文件。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { COMFY_ROOT } from './config.mjs';

const MODEL_EXT = /\.(safetensors|gguf|ckpt|pt|pth|bin)$/i;

function listDir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function listModelFiles(sub) {
  if (!COMFY_ROOT) return [];
  const dir = join(COMFY_ROOT, 'models', sub);
  const out = [];
  const walk = (d, depth = 0) => {
    if (!d || depth > 2) return;
    for (const name of listDir(d)) {
      const p = join(d, name);
      if (existsSync(p) && !name.includes('.')) walk(p, depth + 1);
      else if (MODEL_EXT.test(name)) out.push(name);
    }
  };
  walk(dir);
  return out;
}

/**
 * @param {object} info  /object_info 的结果（可为 null：ComfyUI 没启动时也能给出「缺什么」）
 */
export function capabilityReport(info = null) {
  const nodes = info ? new Set(Object.keys(info)) : null;
  const hasNode = (name) => (nodes ? nodes.has(name) : null); // null = 未知（ComfyUI 没连上）
  const custom = COMFY_ROOT ? listDir(join(COMFY_ROOT, 'custom_nodes')) : [];
  const hasPack = (re) => custom.some((d) => re.test(d));

  const controlnets = listModelFiles('controlnet');
  const clipVision = listModelFiles('clip_vision');
  const loras = listModelFiles('loras');
  const unets = [...listModelFiles('unet'), ...listModelFiles('diffusion_models'), ...listModelFiles('checkpoints')];

  const caps = [];
  const add = (c) => caps.push(c);

  // ---- 基础：能不能出图
  const hasFluxStack = unets.length > 0;
  add({
    id: 'text2image',
    title: '文生图（基础）',
    ok: hasFluxStack ? true : (nodes ? false : null),
    evidence: hasFluxStack ? `unet/checkpoints 里 ${unets.length} 个模型` : '没找到模型文件',
    ifMissing: '把主模型放进 ComfyUI/models/unet（GGUF 需 ComfyUI-GGUF 节点）',
  });

  // ---- 局部重绘（不需要任何插件）
  add({
    id: 'inpaint',
    title: '局部重绘（蒙版内改，蒙版外不动）',
    ok: hasNode('SetLatentNoiseMask') === null ? null : !!hasNode('SetLatentNoiseMask'),
    evidence: '只需要内置节点 SetLatentNoiseMask + VAEEncode，不装插件也能做',
    ifMissing: '内置功能，正常 ComfyUI 都有',
  });

  // ---- 控制网：形状/构图/姿势
  const hasCN = controlnets.length > 0;
  add({
    id: 'controlnet',
    title: '控制网（用参考图定形状：机型、姿势、构图）',
    ok: hasNode('ControlNetLoader') === null ? (hasCN ? true : null) : (hasCN && !!hasNode('ControlNetLoader')),
    evidence: hasCN ? `controlnet 目录 ${controlnets.length} 个模型：${controlnets.slice(0, 2).join(', ')}` : '没有 controlnet 模型',
    ifMissing: '放一个 ControlNet 模型到 models/controlnet（FLUX 用 Union Pro，约 4GB；SD 系小得多，~1.5GB）',
    cost: hasCN ? '已具备' : '~1.5–4GB',
  });

  // ---- 角色一致性：不装插件能做到什么
  add({
    id: 'character-lite',
    title: '角色一致性（不装插件：种子 + 同一提示词 + 低 denoise 重绘 + 同构图）',
    ok: true,
    evidence: '纯工作流手段：固定 seed、复用同一段人物描述、用 img2img 低 denoise(0.3–0.45) 保持脸和衣服、用蒙版只改背景',
    caveat: '能稳住「风格和大致长相」，换构图/换姿势后脸会漂——这是提示词能到的极限',
  });

  // ---- 角色一致性：要真正稳，需要外部能力
  const ipaPack = hasPack(/ipadapter/i);
  const ipaNode = hasNode('IPAdapterUnifiedLoader') === true;
  const ipaModels = [...listModelFiles('ipadapter'), ...listModelFiles('clip_vision')];
  const puPack = hasPack(/pulid/i);
  const puNode = hasNode('PulidFluxNode') === true;
  // 包在 ≠ 能用：节点在但模型文件不在，等于装了个空壳，必须说清楚
  const ipaUsable = (ipaPack || ipaNode) && ipaModels.length > 0;
  const puUsable = puPack || puNode;
  const charStrongOk = ipaUsable || puUsable;
  const charEvidence = [
    ipaPack || ipaNode ? `IPAdapter 节点${ipaNode ? '已加载' : '（包在，节点未确认）'}，模型文件 ${ipaModels.length} 个` : null,
    puPack || puNode ? 'PuLID 节点在' : null,
    loras.length ? `LoRA ${loras.length} 个` : '没有任何角色 LoRA',
  ].filter(Boolean).join('；');
  add({
    id: 'character-strong',
    title: '角色一致性（跨构图/跨姿势仍像同一个人）',
    ok: charStrongOk,
    evidence: charEvidence || '没装 IPAdapter / PuLID，也没有角色 LoRA',
    ifMissing: (ipaPack || ipaNode) && ipaModels.length === 0
      ? 'IPAdapter 的包已经在了，缺的是模型文件：把 ip-adapter*.safetensors 放进 models/ipadapter、'
        + 'CLIP Vision（vit-h 或 bigG，要和模型配对）放进 models/clip_vision，约 1.5–3.5GB。'
        + '注意 FLUX 不认 SD 版 IPAdapter，需要 XLabs/Shakker 的 FLUX 分支（实验性）。'
      : '三条路，按代价从小到大：① IPAdapter + clip_vision（约 3.5GB，一张参考图当临时 LoRA，FLUX 上属实验性）'
        + ' ② PuLID-Flux（人脸专用，约 1GB + insightface）'
        + ' ③ 训一个角色 LoRA（20–30 张同角色图，不额外下载大模型，但要训练时间）',
    cost: charStrongOk ? '已具备' : '1–3.5GB 或 一次训练',
  });

  // ---- 指令式改图（换模型路线，而不是加插件）
  const kontext = unets.some((f) => /kontext|qwen[-_]?image[-_]?edit|fill/i.test(f));
  add({
    id: 'instruction-edit',
    title: '指令式改图（「把这张图的飞机换成 C-130」一句话搞定）',
    ok: kontext,
    evidence: kontext ? '有 Kontext / Qwen-Image-Edit / Fill 类模型' : '只有基础生成模型',
    ifMissing: '这不是插件问题，是模型能力问题：Flux Kontext / Qwen-Image-Edit 这类「编辑模型」天生会保持主体一致地改局部。'
      + '换一个量化版（约 6–12GB）就替代掉一堆插件，代价比装 5 个插件低',
    cost: kontext ? '已具备' : '6–12GB（一个模型，换掉一堆插件）',
  });

  // ---- 视频 / 多参考（MiniMax H3 这类：用一个模型理解「多份参考之间的关系」）
  const H3_NODES = ['MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo'];
  const h3NodesPresent = nodes ? H3_NODES.every((n) => nodes.has(n)) : null;
  /** 从 object_info 的模型下拉里找 H3 权重（文件名带 h3 / minimax） */
  const weightsLookingLike = (re) => {
    if (!info) return [];
    const out = [];
    for (const def of Object.values(info)) {
      for (const group of [def?.input?.required, def?.input?.optional]) {
        for (const spec of Object.values(group || {})) {
          const opts = Array.isArray(spec?.[0]) ? spec[0] : null;
          if (!opts) continue;
          for (const o of opts) if (typeof o === 'string' && re.test(o)) out.push(o);
        }
      }
    }
    return [...new Set(out)];
  };
  const h3Weights = weightsLookingLike(/minimax.?h3|h3.?(base|fl2va|ref2va)|fl2va|ref2va/i);

  add({
    id: 'video',
    title: '视频生成（文/图生视频，含同步音频）',
    ok: h3NodesPresent === false ? false : (h3NodesPresent ? h3Weights.length > 0 : null),
    evidence: h3NodesPresent
      ? (h3Weights.length ? `节点在，权重 ${h3Weights.length} 个：${h3Weights.slice(0, 3).join(', ')}`
        : '节点已内置（ComfyUI ≥0.30.0），但没找到 H3 权重文件')
      : (h3NodesPresent === null ? 'ComfyUI 没连上，无法确认' : '没有 H3 节点（需要 ComfyUI ≥ 0.30.0）'),
    ifMissing: 'ComfyUI 0.30+ 已内置 H3 节点，缺的只是权重：Template Library > Video > MiniMax H3 T2V/I2V，'
      + '按弹出的模型扫描下载（Comfy-Org 的 pruned/INT8/NVFP4 版）。分辨率用 1344×768 或 0.98MP×32 倍数，别用 1.0MP。',
    cost: h3Weights.length ? '已具备' : '一个视频模型（量化版，体积大；8GB 显存是风险点）',
  });

  // r2v 到底能不能用：实测结论是「R2V 节点 + 任意 H3 权重」就够（黑鹤派工作流用的就是
  // 和本机同一份 DasiwaMinimaxH3_*_int8，并没有单独的 Ref2VA 权重）。所以判据不再赌文件名。
  add({
    id: 'multiref',
    title: '多参考一致性（同一主体，换镜头/换姿势）',
    ok: h3NodesPresent === null ? null : (h3NodesPresent && h3Weights.length > 0),
    evidence: h3NodesPresent
      ? (h3Weights.length
        ? `R2V 节点在，H3 权重 ${h3Weights.length} 个；实测可跑（comfy_video mode=2pass 走的就是 r2v）`
        : 'R2V 节点在（MiniMaxH3ReferenceToVideo），但没有 H3 权重')
      : '需要 ComfyUI ≥0.30.0 的 R2V 节点',
    ifMissing: '① 先用现有 H3 权重跑 R2V（照 comfy_video mode=2pass，提示词里用 <Picture 1> 指代参考）；'
      + '② 还不够稳再考虑单独的 Ref2VA 权重；③ 不换模型只能靠多视角参考图 + 3D 渲染 + LoRA 凑，跨视角会漂。',
    cost: h3Weights.length ? '已具备' : 'Ref2VA 权重',
  });

  // ---- H3 高清二采（低清一采 → latent 放大 → 分块重采样）
  const upscaleNodes = ['MMH3UltimateUpscale', 'MinimaxH3LatentUpscaler3D'];
  const upscaleNodesPresent = nodes ? upscaleNodes.some((n) => nodes.has(n)) : null;
  const latentUpscalers = weightsLookingLike(/latent_upscaler_3d|latent.?upscale.*h3|h3.*latent.?upscal/i);
  add({
    id: 'h3-2pass',
    title: 'H3 高清成片（低清抽卡 → latent 放大 → 分块低噪声重采样）',
    ok: upscaleNodesPresent === null ? null : (upscaleNodesPresent && latentUpscalers.length > 0),
    evidence: upscaleNodesPresent
      ? (latentUpscalers.length
        ? `放大节点在，学习型权重 ${latentUpscalers.length} 个：${latentUpscalers.slice(0, 2).join(', ')}`
        : '放大节点在，但 models/latent_upscale_models 里没有 H3 放大权重')
      : '没有 MMH3 / MinimaxH3LatentUpscaler3D 节点',
    ifMissing: '需要两样：① PlagueKind 的 MMH3 Ultimate Upscale 或 Comfyui_Minimax_h3_latent_Upscaler 节点包；'
      + '② minimax_h3_latent_upscaler_3d_*.safetensors 放进 models/latent_upscale_models（约 690MB）。'
      + '两样都在就能直接跑 comfy_video mode=2pass。',
    cost: upscaleNodesPresent && latentUpscalers.length ? '已具备' : '一个节点包 + 约 690MB 权重',
  });

  // ---- 文字渲染
  add({
    id: 'text-render',
    title: '画面内文字（招牌、路牌、LOGO）',
    ok: false,
    evidence: 'FLUX Q4 的文字先验很弱，汉字基本没有',
    ifMissing: '要么换擅长文字的模型（Qwen-Image / SD3.5 large 也不好），要么后期排版叠加——这是最省资源的路',
  });

  // ---- 分区提示
  const hasRegional = hasPack(/regional|attention.?couple|ppm/i);
  add({
    id: 'regional',
    title: '分区提示（左边一个东西、右边另一个）',
    ok: hasRegional,
    evidence: hasRegional ? '有 regional/attention couple 类节点' : '没有分区提示节点',
    ifMissing: '可以用「分开生成 + 蒙版合成」替代（已有 comfy_composite / comfy_edit），不必装节点',
  });

  return {
    comfy_root: COMFY_ROOT,
    nodes_known: !!nodes,
    installed_packs: custom.filter((d) => !/^__/.test(d)).length,
    caps,
    summary: {
      ok: caps.filter((c) => c.ok === true).length,
      missing: caps.filter((c) => c.ok === false).length,
      total: caps.length,
    },
  };
}

/** 终端里的表格版 */
export function renderCapabilities(rep) {
  const mark = (v) => (v === true ? '[有]' : v === false ? '[缺]' : '[?] ');
  const lines = [
    `能力清单（已装自定义节点包：${rep.installed_packs} 个）`,
    '',
    ...rep.caps.map((c) => {
      const head = `${mark(c.ok)} ${c.title}`;
      const tail = c.ok ? `     依据：${c.evidence}` : `     缺：${c.ifMissing}${c.cost ? `（代价 ${c.cost}）` : ''}`;
      return head + '\n' + tail + (c.caveat ? `\n     注意：${c.caveat}` : '');
    }),
  ];
  return lines.join('\n');
}
