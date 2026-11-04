// test/controlnet.mjs — 验证「参考图 → Canny → ControlNet → 出图」这条链路
// node test/controlnet.mjs --ref <本地参考图> --prompt "..." [--strength 0.65] [--w 1024] [--h 1024] [--steps 20]
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ref = arg('ref');
const prompt = arg('prompt');
const strength = Number(arg('strength', '0.65'));
const width = Number(arg('w', '1024'));
const height = Number(arg('h', '1024'));
const steps = Number(arg('steps', '20'));
const cn = arg('cn', 'flux-cn-union-pro-2.0.safetensors');
const seed = Number(arg('seed', String(Math.floor(Math.random() * 2 ** 31))));

if (!ref || !prompt) { console.error('需要 --ref 与 --prompt'); process.exit(2); }

const t = new StdioClientTransport({ command: process.execPath, args: [join(HERE, '..', 'server.mjs')], stderr: 'pipe' });
const c = new Client({ name: 'cn-e2e', version: '1.0' });
await c.connect(t);
const parse = (r) => { try { return JSON.parse(r.content.find((x) => x.type === 'text').text); } catch { return {}; } };

const up = parse(await c.callTool({ name: 'comfy_upload', arguments: { path: ref } }));
if (!up.ok) { console.error('上传失败', up); process.exit(1); }
console.log('uploaded as', up.name);

const wf = {
  1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux1-dev-Q4_K_S.gguf' } },
  2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl_fp16.safetensors', type: 'flux' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'flux-ae.safetensors' } },
  4: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: prompt } },
  5: { class_type: 'FluxGuidance', inputs: { conditioning: ['4', 0], guidance: 3.5 } },
  6: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: '' } },
  7: { class_type: 'LoadImage', inputs: { image: up.name } },
  8: { class_type: 'ImageScale', inputs: { image: ['7', 0], upscale_method: 'lanczos', width, height, crop: 'center' } },
  9: { class_type: 'Canny', inputs: { image: ['8', 0], low_threshold: 0.4, high_threshold: 0.8 } },
  10: { class_type: 'ControlNetLoader', inputs: { control_net_name: cn } },
  11: { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['5', 0], negative: ['6', 0], control_net: ['10', 0], image: ['9', 0], strength, start_percent: 0.0, end_percent: 1.0, vae: ['3', 0] } },
  12: { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: 1 } },
  13: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['11', 0], negative: ['11', 1], latent_image: ['12', 0], seed, steps, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0 } },
  14: { class_type: 'VAEDecode', inputs: { samples: ['13', 0], vae: ['3', 0] } },
  15: { class_type: 'SaveImage', inputs: { images: ['14', 0], filename_prefix: 'cn/test' } },
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
console.log(JSON.stringify({ ok: data.ok, error: data.error, errors: data.errors, diagnosis: data.diagnosis, output: data.outputs?.[0] }, null, 2).slice(0, 1200));
await c.close();
