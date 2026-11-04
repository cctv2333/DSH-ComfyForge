// test/curate.mjs — 批量生成 → 等齐 → 汇总（给「多生成、再挑」用）
// node test/curate.mjs --prompt "..." --width 1344 --height 768 --count 4
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SERVER = join(HERE, '..', 'server.mjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

const prompt = arg('prompt', 'a cozy workshop at dusk, brass tools on a wooden bench, warm lamp light, dust in the air, cinematic photograph');
const width = Number(arg('width', '1344'));
const height = Number(arg('height', '768'));
const count = Number(arg('count', '4'));
const steps = Number(arg('steps', '20'));
const template = arg('template', 'flux_t2i');
const prefix = arg('prefix', 'curate/batch');

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
const client = new Client({ name: 'comfyforge-curate', version: '0.2.0' });
await client.connect(transport);
const parse = (r) => { try { return JSON.parse(r?.content?.find((c) => c.type === 'text')?.text || '{}'); } catch { return {}; } };

const seeds = Array.from({ length: count }, () => Math.floor(Math.random() * 2147483647));
console.log(`批量 ${count} 张 ${width}x${height} steps=${steps}\nseeds=${seeds.join(', ')}`);

const t0 = Date.now();
let res = await client.callTool({
  name: 'comfy_batch',
  arguments: { template, params: { prompt, width, height, steps, filename_prefix: prefix }, seeds, wait_s: 50, view: 'none' },
});
let data = parse(res);
if (!data.count) {
  console.log('调用返回异常：', JSON.stringify(data).slice(0, 600));
  console.log('原始内容：', String(res?.content?.[0]?.text || '').slice(0, 600));
  await client.close();
  process.exit(1);
}
console.log(`提交 ${data.count} 个；remaining=${(data.remaining || []).length}`);

const collected = [];
const take = (jobs) => {
  for (const j of jobs || []) {
    if (!j.outputs) continue;
    for (const o of j.outputs) collected.push({ ...o, prompt_id: j.prompt_id, seed: j.seed });
  }
};
take(data.batch);

let rounds = 0;
while ((data.remaining || []).length && rounds < 12) {
  await new Promise((r) => setTimeout(r, 1500));
  data = parse(await client.callTool({ name: 'comfy_wait_many', arguments: { prompt_ids: data.remaining, wait_s: 50, view: 'none' } }));
  take(data.jobs);
  rounds++;
  console.log(`  轮 ${rounds}: 本轮完成 ${data.done ?? 0}，剩 ${(data.remaining || []).length}`);
}

const all = collected;

console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，图片 ${all.length} 张`);
for (const o of all) {
  const q = o.quality?.verdict || {};
  console.log(`  ${o.width}x${o.height} ${String(Math.round((o.bytes || 0) / 1024)).padStart(5)}KB sharp=${String(q.lap_var_512 ?? '-').padStart(6)} ${String(q.level || '?').toUpperCase().padEnd(6)} ${(q.flags || []).join(',') || '-'}`);
}

if (all.length) {
  const snap = parse(await client.callTool({
    name: 'comfy_snapshot',
    arguments: { images: all.map((o) => ({ filename: o.filename, subfolder: o.subfolder, type: 'output' })), cols: all.length > 2 ? 2 : 1, cell: 620 },
  }));
  const img = snap?.content?.find?.((c) => c.type === 'image');
  console.log(`\n联络表：${snap.sheet}`);
  if (img) console.log(`联络表 base64 ${Math.round(img.data.length / 1024)}KB`);
}

await client.close();
