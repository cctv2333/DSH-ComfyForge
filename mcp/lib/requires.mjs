// lib/requires.mjs — 每个能力到底依赖什么，以及在没有这些依赖的机器上会怎样
//
// 设计前提（回应「换个电脑怎么办」）：
//   1. 一台机器可能只有 Node，连 ComfyUI 都没装；也可能 ComfyUI 在跑但没有我们的模型。
//   2. 检查必须在**任何**环境都能跑出结论：没有 ComfyUI 时仍能查磁盘、查 ffmpeg、查 Node。
//   3. 每缺一样都要说清三件事：缺的是什么、多大、放哪里。
//   4. 允许"降级"：比如没有 VideoHelperSuite 仍能出视频（改用 SaveImage + 外部 ffmpeg）。
//      降级要明说代价，不能假装和原来一样。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const GIB = 1024 ** 3;

/** 依赖描述。node 名都用 ComfyUI 的 class_type，方便直接对着 /object_info 查。 */
export const CAPABILITIES = [
  {
    id: 'lint',
    title: '提示词校验',
    what: '六段结构 / 引用闭合 / 时间码 / 帧数 / 手分工 等 20+ 条规则',
    needs: { comfy: false, nodes: [], packs: [], models: [], bins: [] },
    optional: [{ what: '语义层（左右手自相矛盾、动作物理可行性）', need: '一个 OpenAI 兼容端点（Ollama 1.5B 约 1GB）', sizeGb: 1 }],
  },
  {
    id: 'metrics',
    title: '视频客观指标',
    what: '帧间差分 / 黑帧 / 强切点 / 音量 / 时长分辨率',
    needs: { comfy: false, nodes: [], packs: [], models: [], bins: ['ffmpeg'] },
  },
  {
    id: 'music-video',
    title: '音乐视频合成（循环铺满 + 混音）',
    what: '正放+倒放无缝循环、按目标时长铺满、混入音轨、片尾淡出',
    needs: { comfy: false, nodes: [], packs: [], models: [], bins: ['ffmpeg'] },
  },
  {
    id: 'image-sheet',
    title: '角色三视图 / 立绘',
    what: 'Illustrious / SDXL / FLUX 文生图与图生图',
    needs: {
      comfy: true,
      nodes: ['CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'],
      packs: [],
      models: [{ dir: 'checkpoints', match: /\.safetensors$/i, sizeGb: 6.5, role: '任意 SDXL / Illustrious 动漫底模（也接受 FLUX 三件套，但更占空间）', minCount: 1 }],
    },
    minimal: 'ComfyUI 本体 + 一个 6.5GB 的动漫底模。这是"能出图"的最低门槛。',
  },
  {
    id: 'video-single',
    title: 'H3 视频（单遍 i2v）',
    what: '一张图 → 带原生音轨的短视频',
    needs: {
      comfy: true,
      nodes: ['UNETLoader', 'CLIPLoader', 'VAELoader', 'MiniMaxH3ImageToVideo', 'MiniMaxH3SigmaShift', 'BasicGuider', 'RandomNoise', 'KSamplerSelect', 'BasicScheduler', 'SamplerCustomAdvanced', 'VAEDecode'],
      packs: [],
      models: [
        { dir: 'diffusion_models', match: /minimax.?h3/i, sizeGb: 19.5, role: 'H3 主模型（int8）', required: true },
        { dir: 'text_encoders', match: /qwen3vl_32b_minimax_h3/i, sizeGb: 25.3, role: 'H3 文本编码器（Qwen3VL 32B int8）', required: true },
        { dir: 'vae', match: /minimax_h3_video_vae/i, sizeGb: 4.85, role: '视频 VAE', required: true },
        { dir: 'vae', match: /minimax_h3_audio_vae/i, sizeGb: 0.56, role: '音频 VAE（不要音轨可不装）', required: false },
        { dir: 'loras', match: /TaoMate.*3step/i, sizeGb: 1.16, role: '加速 LoRA（省一半步数，可选）', required: false },
      ],
    },
    minimal: 'ComfyUI ≥0.30 + 约 51GB 权重。这是目前最贵的一项，也是唯一能出"带声音的视频"的路线。',
    fallback: '没有 H3 权重时的替代：用 ffmpeg 对一张图做缓慢推/摇（Ken Burns），零模型，但画面是静止的。',
  },
  {
    id: 'video-2pass',
    title: 'H3 高清二采（低清 → latent 放大 → 分块重采样）',
    what: '608×352 一采 + 学习型 3D 放大 ×2 + 分块精修，8GB 显存能出 1216×704',
    needs: {
      comfy: true,
      nodes: ['MiniMaxH3ReferenceToVideo', 'ModelAttentionBackend', 'LTXVSeparateAVLatent', 'LTXVConcatAVLatent', 'SplitSigmas', 'ConditioningZeroOut', 'MinimaxH3LatentUpscaler3D', 'MMH3UltimateUpscale', 'MMH3TemporalSplitParams', 'VHS_VideoCombine'],
      packs: [
        { name: 'ComfyUI-PlagueKind-Nodes（ComfyUI-H3-UltimateUpscale-LD）', provides: 'MMH3UltimateUpscale / MMH3TemporalSplitParams' },
        { name: 'Comfyui_Minimax_h3_latent_Upscaler', provides: 'MinimaxH3LatentUpscaler3D' },
        { name: 'ComfyUI-VideoHelperSuite', provides: 'VHS_VideoCombine' },
      ],
      models: [{ dir: 'latent_upscale_models', match: /minimax_h3_latent_upscaler_3d/i, sizeGb: 0.64, role: '学习型 3D latent 放大权重', required: true }],
    },
    minimal: '在"单遍"的基础上 + 2 个自定义节点包 + 0.64GB 权重。',
    degrade: '缺 MMH3 时可以只做"低清一采 + ffmpeg 插值放大（lanczos）"——不出细节，但不会花屏。',
  },
  {
    id: 'sweep',
    title: '低清抽卡批跑',
    what: '一批 seed 出草片 → 指标排序 → 只精修前 K 条',
    needs: { comfy: true, nodes: [], packs: [], models: [], bins: ['ffmpeg'], inherits: ['video-2pass'] },
    minimal: '就是 2pass 的批量版，依赖与它完全相同。',
  },
  {
    id: 'workflow-check',
    title: '工作流体检（缺哪个节点 / 哪个模型）',
    what: '把任意工作流拆成 A/B/C/D 四类缺件',
    needs: { comfy: true, nodes: [], packs: [], models: [] },
    minimal: '需要 ComfyUI 正在运行（要读 /object_info）。',
  },
];

/** 磁盘上按目录 + 正则找模型文件 */
function scanModels(comfyRoot, dir, match) {
  if (!comfyRoot) return null;
  const base = join(comfyRoot, 'models', dir);
  if (!existsSync(base)) return [];
  const out = [];
  const walk = (d, depth = 0) => {
    if (depth > 2) return;
    let names;
    try { names = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!match.test(e.name)) continue;
      let size = 0;
      try { size = statSync(p).size; } catch { /* ignore */ }
      out.push({ name: e.name, sizeGb: +(size / GIB).toFixed(2) });
    }
  };
  walk(base);
  return out;
}

/**
 * 逐项检查。
 * @param {object} o
 * @param {Set<string>|null} o.nodes  /object_info 的节点名集合（null = ComfyUI 没连上）
 * @param {string|null} o.comfyRoot   ComfyUI 根目录（null = 远程/不知道）
 * @param {(b:string)=>boolean} o.hasBin  ffmpeg 等外部命令是否可用
 */
export function checkRequirements({ nodes, comfyRoot, hasBin } = {}) {
  const rows = [];
  for (const cap of CAPABILITIES) {
    const missing = [];
    const warns = [];

    if (cap.needs.comfy) {
      if (nodes === null) {
        missing.push({ kind: 'unknown', what: 'ComfyUI 没连上，无法确认节点', how: '启动 ComfyUI 后重跑；或用 COMFY_URL 指向它' });
      } else {
        for (const n of cap.needs.nodes || []) {
          if (!nodes.has(n)) missing.push({ kind: 'node', what: `节点 ${n}`, how: 'ComfyUI 版本过低，或来自未安装的自定义包' });
        }
        for (const p of cap.needs.packs || []) {
          const provided = (p.provides || '').split(' / ').filter(Boolean);
          const gone = provided.filter((n) => !nodes.has(n));
          if (gone.length) missing.push({ kind: 'pack', what: `${p.name}（缺 ${gone.join(' / ')}）`, how: '把该包放进 custom_nodes 并重启 ComfyUI' });
        }
      }
    }

    for (const m of cap.needs.models || []) {
      const found = scanModels(comfyRoot, m.dir, m.match);
      if (found === null) {
        if (nodes === null) warns.push({ kind: 'unknown', what: `无法确认 ${m.role}（既没连上 ComfyUI，也不知道 COMFY_ROOT）` });
        continue;
      }
      const hit = found.length >= (m.minCount || 1);
      if (!hit && m.required !== false) {
        missing.push({
          kind: 'model',
          what: `${m.role}（约 ${m.sizeGb}GB）`,
          how: `放进 models/${m.dir}/，文件名要能匹配 ${m.match}`,
        });
      } else if (!hit) {
        warns.push({ kind: 'optional', what: `${m.role} 未安装（可选，约 ${m.sizeGb}GB）` });
      }
    }

    for (const b of cap.needs.bins || []) {
      if (!hasBin || !hasBin(b)) missing.push({ kind: 'bin', what: `外部命令 ${b}`, how: `装 ${b} 并放进 PATH，或设 ${b.toUpperCase()}_PATH 指向可执行文件` });
    }

    const hard = missing.filter((m) => m.kind !== 'unknown');
    rows.push({
      id: cap.id, title: cap.title, what: cap.what,
      // 三态：ok=确认可用 / unknown=没法确认（ComfyUI 没连上）/ missing=确认缺件
      status: missing.length === 0 ? 'ok' : hard.length === 0 ? 'unknown' : 'missing',
      ok: missing.length === 0,
      missing, warns,
      minimal: cap.minimal || null,
      degrade: cap.degrade || cap.fallback || null,
      optional: cap.optional || null,
    });
  }
  return rows;
}

/** 汇总：能做什么 / 差什么 */
export function summarize(rows) {
  const ok = rows.filter((r) => r.ok);
  const unknown = rows.filter((r) => r.status === 'unknown');
  const bad = rows.filter((r) => r.status === 'missing');
  return {
    canDo: ok.map((r) => r.title),
    unknown: unknown.map((r) => r.title),
    cannot: bad.map((r) => ({ title: r.title, missing: r.missing.filter((m) => m.kind !== 'unknown').map((m) => m.what) })),
    okCount: ok.length, unknownCount: unknown.length, total: rows.length,
  };
}
