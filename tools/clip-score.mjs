// tools/clip-score.mjs —— 用 CLIP 图像向量给「像不像参考角色」打分（可批量、可复现）
//
// 做法：
//   1. 每张图过一次 CLIP-ViT-H（经 IPAdapter 的投影层），把 embedding 存成 .ipadpt
//   2. 与参考图的 embedding 算余弦相似度（用 CLS token，不用 patch 均值）
//   3. 输出排序 + 写一份 JSON
//
// 为什么用这个而不是配色：配色只能说明"颜色像"，说明不了"是不是同一个人"。
// CLIP 图像向量恰好是 IPAdapter 自己判断"像不像"用的那个空间。
//
// ⚠ 它是一个**判别器**，不是排序器：低于阈值≈0.78 基本可以判"不像"；
//   但在 0.80 与 0.83 之间比大小，噪声可能大于差异。别拿它给好图分高下。
//
// 用法:
//   node tools/clip-score.mjs <图1> [图2 ...] --ref=<参考图> [--out=.cache/clip-scores.json]
//
// 环境：COMFYFORGE_PY 指向带 torch 的 python（默认吃 PATH 里的 python）。
import fs from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { submit, waitFor, parseHistoryEntry, COMFY_ROOT, OUTPUT_DIR, PROJECT_ROOT } from '../mcp/lib/comfy.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};
const files = args.filter((a) => !a.startsWith('--'));
// 不写死本机路径：参考图必须由使用者给出（--ref 或 COMFY_INPUT + 文件名）
const inputDirBase = process.env.COMFY_INPUT || (COMFY_ROOT ? join(COMFY_ROOT, 'input') : null);
const refPath = opt('ref', null);
const outJson = opt('out', join(PROJECT_ROOT, '.cache', 'clip-scores.json'));

if (!files.length || !refPath) {
  console.error('用法: node tools/clip-score.mjs <图...> --ref=<参考图> [--out=...]');
  console.error('（参考图是"像不像"的基准，必须明确给出）');
  process.exit(2);
}
if (!fs.existsSync(refPath)) {
  console.error(`参考图不存在：${refPath}${inputDirBase ? `（也查过 ${inputDirBase}）` : ''}`);
  process.exit(2);
}
if (!COMFY_ROOT) {
  console.error('需要 COMFY_ROOT：要把图暂存进 ComfyUI 的 input 目录，LoadImage 只认那里');
  process.exit(2);
}

const runId = String(Date.now());
const inputDir = join(COMFY_ROOT, 'input');
const stageDir = join(inputDir, 'clipscore');
fs.mkdirSync(stageDir, { recursive: true });

/** 把任意位置的图拷进 input 目录（LoadImage 只认这里） */
function stage(p, tag) {
  const ext = (p.match(/\.(png|jpe?g|webp)$/i) || [, 'png'])[1];
  fs.copyFileSync(p, join(stageDir, `${tag}.${ext}`));
  return `clipscore/${tag}.${ext}`;
}

function wf(imageName, tag) {
  return {
    1: { class_type: 'CLIPVisionLoader', inputs: { clip_name: 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors' } },
    2: { class_type: 'IPAdapterModelLoader', inputs: { ipadapter_file: 'ip-adapter-plus_sdxl_vit-h.safetensors' } },
    3: { class_type: 'LoadImage', inputs: { image: imageName } },
    4: { class_type: 'IPAdapterEncoder', inputs: { ipadapter: ['2', 0], image: ['3', 0], weight: 1, clip_vision: ['1', 0] } },
    5: { class_type: 'IPAdapterSaveEmbeds', inputs: { embeds: ['4', 0], filename_prefix: `clipscore/${runId}/${tag}` } },
  };
}

async function embed(path, tag) {
  const name = stage(path, tag);
  const res = await submit(wf(name, tag), { clientId: 'clipscore' });
  for (let k = 0; k < 60; k++) {
    const r = await waitFor(res.prompt_id, { timeoutS: 20 });
    if (!r.pending) {
      const p = parseHistoryEntry(r.entry);
      if (p.errors?.length) return { ok: false, error: JSON.stringify(p.errors[0]).slice(0, 200) };
      return { ok: true };
    }
  }
  return { ok: false, error: 'timeout' };
}

const items = [{ path: refPath, tag: 'ref', role: 'reference' }];
files.forEach((f, i) => items.push({ path: f, tag: `i${String(i).padStart(2, '0')}`, role: 'candidate' }));

console.log(`编码 ${items.length} 张（参考 1 + 候选 ${files.length}）…`);
for (const it of items) {
  const r = await embed(it.path, it.tag);
  it.encoded = r.ok;
  if (!r.ok) console.log(`  ✗ ${basename(it.path)}: ${r.error}`);
}

// 找 SaveEmbeds 落在哪
const cands = [
  join(OUTPUT_DIR || '', 'clipscore', runId),
  join(COMFY_ROOT, 'output', 'clipscore'),
  join(inputDir, 'clipscore'),
].filter(Boolean);
const isEmb = (f) => /\.(ipadpt|pt|pth|safetensors)$/i.test(f);
const embDir = cands.find((d) => fs.existsSync(d) && fs.readdirSync(d).some(isEmb));
if (!embDir) { console.error('没找到 embedding 输出目录，检查过：', cands); process.exit(1); }
console.log(`embedding 目录：${embDir}`);

// 用带 torch 的 python 算余弦（默认吃 PATH；没有就把 COMFYFORGE_PY 指向 ComfyUI 自带的那个）
const py = process.env.COMFYFORGE_PY || 'python';
const prog = `
import sys, os, json, glob
import torch
d, ref_tag = sys.argv[1], sys.argv[2]
def load(tag):
    hits = [h for h in sorted(glob.glob(os.path.join(d, tag + '*'))) if h.lower().endswith(('.ipadpt','.pt','.pth','.safetensors'))]
    if not hits: return None
    obj = torch.load(hits[0], map_location='cpu', weights_only=False)
    if isinstance(obj, dict):
        for k in ('image_embeds','embeds','pos_embed','output'):
            if k in obj: obj = obj[k]; break
    t = obj if torch.is_tensor(obj) else list(obj)[0]
    t = t.float()
    if t.dim() == 3:                     # (1, 257, 1280): 第 0 个是 CLS，其余是 patch
        cls = t[0, 0, :]
        patches = t[0, 1:, :].mean(0)
    else:
        cls = t.flatten(); patches = cls
    cls = cls / cls.norm(); patches = patches / patches.norm()
    return cls, patches
ref = load(ref_tag)
out = []
for p in sorted([h for h in glob.glob(os.path.join(d, 'i*')) if h.lower().endswith(('.ipadpt','.pt','.pth','.safetensors'))]):
    tag = os.path.basename(p).split('.')[0].split('_')[0]
    v = load(tag)
    if v is None or ref is None: continue
    out.append({'tag': tag, 'cos': round(float(torch.dot(ref[0], v[0])), 4), 'cosPatch': round(float(torch.dot(ref[1], v[1])), 4)})
print(json.dumps(out))
`;
const r = spawnSync(py, ['-c', prog, embDir, 'ref'], { encoding: 'utf8' });
if (r.status !== 0) { console.error('算相似度失败（多半是 python 没有 torch，设 COMFYFORGE_PY）：', String(r.stderr).slice(-500)); process.exit(1); }
const sims = JSON.parse(r.stdout);

const byTag = new Map(sims.map((s) => [s.tag, s]));
const rows = items.filter((i) => i.role === 'candidate').map((i) => ({
  path: i.path, tag: i.tag, cos: byTag.get(i.tag)?.cos ?? null, cosPatch: byTag.get(i.tag)?.cosPatch ?? null,
})).filter((x) => x.cos != null);

rows.sort((a, b) => b.cos - a.cos);
console.log('\n按 CLIP 相似度排序（越高越像参考角色）：');
for (const [i, row] of rows.entries()) {
  console.log(`  ${String(i + 1).padStart(2)}. CLS ${row.cos.toFixed(4)}  patch ${row.cosPatch.toFixed(4)}  ${basename(row.path)}`);
}
fs.writeFileSync(outJson, JSON.stringify({ ref: refPath, rows }, null, 2), 'utf8');
console.log(`\n写入 ${outJson}`);
console.log('提示：这是判别器不是排序器。低于约 0.78 判"不像"可靠；0.80 vs 0.83 的差距可能是噪声。');
