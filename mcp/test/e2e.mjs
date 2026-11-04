// test/e2e.mjs — 真实出图：同种子同提示词，多分辨率对比，最后拼一张联络表
// 用法：node test/e2e.mjs [--sizes 512x512,768x768,1024x1024] [--steps 20] [--prompt "..."]
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SERVER = join(HERE, '..', 'server.mjs');

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
};
const sizes = arg('sizes', '512x512,768x768,1024x1024').split(',').map((s) => s.trim());
const steps = Number(arg('steps', '20'));
const seed = Number(arg('seed', '42'));
const prompt = arg('prompt', 'a brass clockwork robot watering a bonsai tree on a wooden table, soft rim light, shallow depth of field, high detail');
const tag = arg('tag', 'eval');

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
const client = new Client({ name: 'comfyforge-e2e', version: '0.2.0' });
await client.connect(transport);

const parse = (res) => {
  const t = res?.content?.find((c) => c.type === 'text')?.text || '';
  try { return JSON.parse(t); } catch { return { raw: t }; }
};

const health = parse(await client.callTool({ name: 'comfy_health', arguments: {} }));
console.log(`ComfyUI ${health.comfyui} | ${health.gpu} | vram free ${health.vram_free}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 提交 + 轮询（每次调用 <55s，绕开 MCP 客户端 60s 超时） */
async function runAndWait(params) {
  const t0 = Date.now();
  let res = await client.callTool({ name: 'comfy_run', arguments: { template: 'flux_t2i', params, wait_s: 50, view: 'none' } });
  let data = parse(res);
  let polls = 0;
  while (data.pending && polls < 10) {
    await sleep(1200);
    res = await client.callTool({ name: 'comfy_wait', arguments: { prompt_id: data.prompt_id, wait_s: 50 } });
    data = parse(res);
    polls++;
  }
  return { data, elapsed_s: (Date.now() - t0) / 1000, polls };
}

const runs = [];
for (const size of sizes) {
  const [w, h] = size.split('x').map(Number);
  const { data, elapsed_s, polls } = await runAndWait({
    prompt, width: w, height: h, steps, seed, filename_prefix: `${tag}/${w}x${h}`,
  });
  const meta = data.outputs?.[0];
  runs.push({ size, ms: elapsed_s * 1000, data, meta, polls });
  if (data.error) {
    console.log(`\n[${size}] FAILED in ${elapsed_s.toFixed(1)}s (${polls} 次等待)`);
    console.log(JSON.stringify(data, null, 2).slice(0, 1600));
  } else {
    const q = meta?.quality;
    console.log(`\n[${size}] ok in ${elapsed_s.toFixed(1)}s (${polls} 次等待)  file=${meta?.filename}  ${meta?.width}x${meta?.height}  ${(meta?.bytes / 1024).toFixed(0)}KB`);
    console.log(`  lap512=${q?.lap_var_512}  edge=${q?.edge_pct}%  contrast=${q?.contrast}  clipH=${q?.clip_high}  clipL=${q?.clip_low}`);
    console.log(`  verdict=${q?.verdict?.level} flags=${(q?.verdict?.flags || []).join(',') || '-'}`);
    for (const n of q?.verdict?.notes || []) console.log('   - ' + n);
    for (const n of q?.verdict?.info || []) console.log('   ~ ' + n);
  }
}

const okRuns = runs.filter((r) => !r.data.error && r.meta?.filename);
if (okRuns.length >= 2) {
  const images = okRuns.map((r) => ({ filename: r.meta.filename, subfolder: r.meta.subfolder, type: 'output' }));
  const snap = await client.callTool({ name: 'comfy_snapshot', arguments: { images, cols: okRuns.length > 2 ? 3 : 2, cell: 480 } });
  const sm = parse(snap);
  const img = snap.content?.find((c) => c.type === 'image');
  console.log(`\n联络表：${sm.sheet}  (${sm.count} 张, ${sm.grid})  图片内容 ${img ? Math.round(img.data.length / 1024) + 'KB base64' : '无'}`);
  console.log('\n汇总：');
  for (const r of runs) {
    const q = r.meta?.quality;
    console.log(`  ${r.size.padEnd(9)} ${String(((r.ms) / 1000).toFixed(1)).padStart(6)}s  ${q ? q.verdict.level.padEnd(6) : 'error '}  lap512=${String(q?.lap_var_512 ?? '-').padStart(7)}  edge=${String(q?.edge_pct ?? '-').padStart(5)}%  ${q?.verdict.flags.join(',') || ''}`);
  }
}

await client.close();
