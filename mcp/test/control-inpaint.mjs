// test/control-inpaint.mjs — 控制画布 + 蒙版局部重绘：把参考图里的物体放进场景
// node test/control-inpaint.mjs --scene <底图> --object <物体图> --box x,y,w,h --prompt "..."
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// 不写死本机路径：优先环境变量，其次 `python`（PATH 里能找到就行）
const PY = process.env.COMFYFORGE_PY || 'python';
const IMGOPS = join(HERE, '..', 'scripts', 'imgops.py');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

const scene = arg('scene');
const objectImg = arg('object');
const prompt = arg('prompt');
const box = arg('box', '').split(',').filter(Boolean).map(Number);
const denoise = Number(arg('denoise', '0.85'));
const strength = Number(arg('strength', '0.9'));
const steps = Number(arg('steps', '20'));
const cn = arg('cn', 'flux-cn-union-pro-2.0.safetensors');
if (!scene || !objectImg || !prompt || box.length !== 4) { console.error('需要 --scene --object --box x,y,w,h --prompt'); process.exit(2); }

const work = join(HERE, '..', '..', '.cache', 'cn-inpaint');
mkdirSync(work, { recursive: true });
const canvas = join(work, 'canvas.png');
const mask = join(work, 'mask.png');

// 1) 控制画布：场景同尺寸的白底，把物体按 box 贴进去（只给 ControlNet 看结构）
const py = `
from PIL import Image
scene = Image.open(r'${scene.replace(/\\/g, '\\\\')}').convert('RGB')
w, h = scene.size
x, y, bw, bh = ${box.join(',')}
obj = Image.open(r'${objectImg.replace(/\\/g, '\\\\')}').convert('RGB')
# 去掉接近纯白的底，尽量只留物体轮廓
obj = obj.resize((bw, bh), Image.LANCZOS)
canvas = Image.new('RGB', (w, h), (255, 255, 255))
canvas.paste(obj, (x, y))
canvas.save(r'${canvas.replace(/\\/g, '\\\\')}')
print('canvas', canvas.size)
`;
const r1 = spawnSync(PY, ['-c', py], { encoding: 'utf8' });
if (r1.status !== 0) { console.error(r1.stderr); process.exit(1); }

// 2) 蒙版：稍微扩张，羽化，边界才不硬
const r2 = spawnSync(PY, [IMGOPS, 'mask', '--in', scene, '--out', mask, '--box', box.join(','), '--expand', '16', '--feather', '18'], { encoding: 'utf8' });
if (r2.status !== 0) { console.error(r2.stderr); process.exit(1); }
console.log('mask', r2.stdout.trim());

const t = new StdioClientTransport({ command: process.execPath, args: [join(HERE, '..', 'server.mjs')], stderr: 'pipe' });
const c = new Client({ name: 'cn-inpaint', version: '1.0' });
await c.connect(t);
const parse = (r) => { try { return JSON.parse(r.content.find((x) => x.type === 'text').text); } catch { return {}; } };

const upScene = parse(await c.callTool({ name: 'comfy_upload', arguments: { path: scene } }));
const upCanvas = parse(await c.callTool({ name: 'comfy_upload', arguments: { path: canvas } }));
const upMask = parse(await c.callTool({ name: 'comfy_upload', arguments: { path: mask } }));
for (const [k, v] of Object.entries({ scene: upScene, canvas: upCanvas, mask: upMask })) if (!v.ok) { console.error(k, '上传失败', v); process.exit(1); }

const wf = {
  1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux1-dev-Q4_K_S.gguf' } },
  2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl_fp16.safetensors', type: 'flux' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'flux-ae.safetensors' } },
  4: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: prompt } },
  5: { class_type: 'FluxGuidance', inputs: { conditioning: ['4', 0], guidance: 3.5 } },
  6: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: '' } },
  7: { class_type: 'LoadImage', inputs: { image: upScene.name } },
  8: { class_type: 'LoadImageMask', inputs: { image: upMask.name, channel: 'red' } },
  9: { class_type: 'VAEEncode', inputs: { pixels: ['7', 0], vae: ['3', 0] } },
  10: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['9', 0], mask: ['8', 0] } },
  11: { class_type: 'LoadImage', inputs: { image: upCanvas.name } },
  12: { class_type: 'Canny', inputs: { image: ['11', 0], low_threshold: 0.4, high_threshold: 0.8 } },
  13: { class_type: 'ControlNetLoader', inputs: { control_net_name: cn } },
  14: { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['5', 0], negative: ['6', 0], control_net: ['13', 0], image: ['12', 0], strength, start_percent: 0.0, end_percent: 1.0, vae: ['3', 0] } },
  15: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['14', 0], negative: ['14', 1], latent_image: ['10', 0], seed: 12345, steps, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise } },
  16: { class_type: 'VAEDecode', inputs: { samples: ['15', 0], vae: ['3', 0] } },
  17: { class_type: 'SaveImage', inputs: { images: ['16', 0], filename_prefix: 'cn/placed' } },
};

const t0 = Date.now();
let res = await c.callTool({ name: 'comfy_run', arguments: { workflow: wf, wait_s: 50, view: 'none' } });
let data = parse(res);
let rounds = 0;
while (data.pending && rounds < 8) {
  await new Promise((r) => setTimeout(r, 1500));
  res = await c.callTool({ name: 'comfy_wait', arguments: { prompt_id: data.prompt_id, wait_s: 50, view: 'none' } });
  data = parse(res);
  rounds++;
}
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s rounds=${rounds}`);
console.log(JSON.stringify({ ok: data.ok, error: data.error, diagnosis: data.diagnosis, output: data.outputs?.[0] }, null, 2).slice(0, 1000));
await c.close();
