// test/edit-e2e.mjs — 验证「局部编辑」能力：只改一块，蒙版外几乎不动
// node test/edit-e2e.mjs --image <path> --box x,y,w,h --prompt "..." [--denoise 0.75]
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

const image = arg('image');
const prompt = arg('prompt');
const box = arg('box', '').split(',').filter(Boolean).map(Number);
const denoise = Number(arg('denoise', '0.75'));
const steps = Number(arg('steps', '20'));
const seed = arg('seed') ? Number(arg('seed')) : undefined;

if (!image || !prompt) { console.error('需要 --image 与 --prompt'); process.exit(2); }

const transport = new StdioClientTransport({ command: process.execPath, args: [join(HERE, '..', 'server.mjs')], stderr: 'pipe' });
const client = new Client({ name: 'edit-e2e', version: '0.2.0' });
await client.connect(transport);

const parse = (r) => { try { return JSON.parse(r?.content?.find((c) => c.type === 'text')?.text || '{}'); } catch { return {}; } };

const t0 = Date.now();
let res = await client.callTool({
  name: 'comfy_edit',
  arguments: {
    image, prompt, denoise, steps, seed,
    ...(box.length === 4 ? { box } : {}),
    wait_s: 50,
  },
});
let data = parse(res);

let rounds = 0;
while (data.pending && rounds < 8) {
  await new Promise((r) => setTimeout(r, 1200));
  res = await client.callTool({ name: 'comfy_edit', arguments: { prompt_id: data.prompt_id, wait_s: 50 } });
  data = parse(res);
  rounds++;
}

console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，轮询 ${rounds} 次`);
console.log(JSON.stringify({ ok: data.ok, error: data.error, prompt_id: data.prompt_id, output: data.outputs?.[0], locality: data.locality, hint: data.hint }, null, 2));

const img = res?.content?.find?.((c) => c.type === 'image');
if (img) console.log(`附带回图 ${Math.round(img.data.length / 1024)}KB`);
await client.close();
