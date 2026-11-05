// sheet-batch.mjs — 按视图分别出图（角度由构造决定，不猜）→ 评分选优 → 拼成设定图
//
// 这是把矛盾重新摆正后的主攻动作：不再搞"生成一堆再推断角度"，而是
//   front / side / back 三条提示词分别出 N 张 → 每个视图只留分最高的一张 → 拼。
// 角度是**构造出来的**，不是推断出来的。
//
// 用法: node tools/sheet-batch.mjs [--seeds=4] [--weight=0.3] [--size=1216x832] [--out=...]
import fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { submit, waitFor, parseHistoryEntry, localOutputPath, PROJECT_ROOT } from '../mcp/lib/comfy.mjs';
import { archive } from '../mcp/lib/archive.mjs';

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};
const nSeeds = +arg('seeds', '4');
const weight = +arg('weight', '0.2');
const [W, H] = arg('size', '1216x832').split('x').map(Number);
const refImage = arg('image', 'whale_maid_crop.png');
const outFile = arg('out', join(PROJECT_ROOT, '.cache', 'sheet-final-v1.png'));
const CKPT = arg('ckpt', 'waiNSFWIllustrious_v130.safetensors');
// 不写死本机 python：优先环境变量，其次 PATH 里的 python
const PY = process.env.COMFYFORGE_PY || 'python';
const BASE = 'masterpiece, best quality, very aesthetic, absurdres, 1girl, solo, one character only, single figure, centered, chibi, super deformed, oversized head, ahoge, full body, standing, long hair, blue hair, gradient hair, blue eyes, huge eyes, maid, frilled headdress, white apron, navy blue dress, blue ribbon, whale print on apron, white socks, navy mary janes, arms at sides, simple background, white background, whale tail emerging from behind her hips at the lower back, pointing down and to one side';
const NEG = 'text, watermark, signature, logo, copyright, letters, lowres, bad anatomy, bad hands, extra digits, worst quality, low quality, jpeg artifacts, blurry, realistic, tall, adult proportions, extra limbs, multiple views, character sheet, 2girls, multiple girls, duplicate, twin, second character, clone, crowd, group, oversized animal, giant whale, whale toy, plush, sticker, frame, border, tail on head, whale on head, whale headdress, whale hat, headwear whale';

const VIEWS = [
  { id: 'front', tag: 'front view, looking at viewer' },
  { id: 'side', tag: 'side view, profile, looking to the side' },
  { id: 'back', tag: 'back view, from behind, facing away' },
];
const SEEDS = Array.from({ length: nSeeds }, (_, i) => 314159 + i * 101);

function build(prompt, seed) {
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: NEG, clip: ['1', 1] } },
    4: { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 } },
    8: { class_type: 'IPAdapterUnifiedLoader', inputs: { model: ['1', 0], preset: 'PLUS (high strength)' } },
    9: { class_type: 'LoadImage', inputs: { image: refImage } },
    11: { class_type: 'PrepImageForClipVision', inputs: { image: ['9', 0], interpolation: 'LANCZOS', crop_position: 'center', sharpening: 0.5 } },
    10: { class_type: 'IPAdapterAdvanced', inputs: { model: ['8', 0], ipadapter: ['8', 1], image: ['11', 0], weight, weight_type: 'linear', combine_embeds: 'concat', start_at: 0, end_at: 1, embeds_scaling: 'V only' } },
    5: { class_type: 'KSampler', inputs: { seed, steps: 30, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['10', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] } },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: `comfyforge/sheet/${'${view}'}_${seed}` } },
  };
}

const made = [];
for (const v of VIEWS) {
  for (const seed of SEEDS) {
    const wf = build(`${BASE}, ${v.tag}`, seed);
    wf['7'].inputs.filename_prefix = `comfyforge/sheet/${v.id}_${seed}`;
    const t0 = Date.now();
    const res = await submit(wf, { clientId: 'sheet-batch' });
    let r;
    for (let k = 0; k < 90; k++) { r = await waitFor(res.prompt_id, { timeoutS: 30 }); if (!r.pending) break; }
    const p = r?.entry ? parseHistoryEntry(r.entry) : null;
    if (!p?.images?.length) { console.log(`✗ ${v.id} ${seed}`); continue; }
    const path = localOutputPath(p.images[0]);
    made.push({ view: v.id, seed, path });
    console.log(`${v.id.padEnd(5)} seed ${seed}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}

// 评分（一次批量）。参考图路径由 --ref-image 或 COMFY_INPUT 决定，不写死本机目录。
const scoreJson = join(PROJECT_ROOT, '.cache', 'clip-scores.json');
const comfyInput = process.env.COMFY_INPUT || (process.env.COMFY_ROOT ? join(process.env.COMFY_ROOT, 'input') : null);
const refPath = arg('ref-image', comfyInput ? join(comfyInput, refImage) : refImage);
const sc = spawnSync(process.execPath, [join(PROJECT_ROOT, 'tools', 'clip-score.mjs'),
  ...made.map((m) => m.path), `--ref=${refPath}`, `--out=${scoreJson}`], { encoding: 'utf8' });
const scores = new Map(JSON.parse(fs.readFileSync(scoreJson, 'utf8')).rows.map((r) => [r.path, r.cos]));
for (const m of made) m.cos = scores.get(m.path) ?? 0;

// 每个视图取最高分
const best = VIEWS.map((v) => made.filter((m) => m.view === v.id).sort((a, b) => b.cos - a.cos)[0]).filter(Boolean);
console.log('\n每个视图的冠军：');
for (const b of best) console.log(`  ${b.view.padEnd(5)} ${b.cos.toFixed(4)}  seed ${b.seed}`);

// 拼
const cp = spawnSync(PY, [join(PROJECT_ROOT, 'tools', 'imgtools.py'), 'compose', outFile, ...best.map((b) => b.path), '--height', '900'], { encoding: 'utf8' });
console.log(String(cp.stdout || cp.stderr).trim());

archive({
  kind: 'sheet-batch',
  goal: '按视图分别生成（角度已知）→ 评分选优 → 拼成三视图定稿',
  workflow: build(`${BASE}, ${VIEWS[0].tag}`, SEEDS[0]),
  params: { model: CKPT, size: `${W}x${H}`, steps: 30, cfg: 6, weight, seeds: SEEDS, views: VIEWS.map((v) => v.id), refImage },
  arms: VIEWS.map((v) => ({
    name: v.id,
    outputs: made.filter((m) => m.view === v.id).map((m) => m.path),
    metrics: { cos: made.filter((m) => m.view === v.id).map((m) => +m.cos.toFixed(4)) },
  })),
  verdict: `每视图冠军：${best.map((b) => `${b.view}=${b.cos.toFixed(3)}(seed ${b.seed})`).join(' / ')}`,
  lesson: '角度由提示词构造，不推断；每视图多出 N 张再按分数取最高，比拼图后再猜角度可靠',
  tags: ['三视图', '批量', '角度构造'],
  outputs: [outFile],
});
console.log(`\n成品：${outFile}`);
