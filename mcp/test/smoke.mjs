// test/smoke.mjs — 最小真实闭环：提交 → pending → 轮询 → 成功 → 指标
// 用 4 步 512 图，约 15-25s；用来验证「ComfyUI 真的能出图」这条主链路。
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SERVER = join(HERE, '..', 'server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
const client = new Client({ name: 'comfyforge-smoke', version: '0.2.0' });
await client.connect(transport);

const parse = (res) => {
  const t = res?.content?.find((c) => c.type === 'text')?.text || '';
  try { return JSON.parse(t); } catch { return { raw: t }; }
};

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failed++;
};

const t0 = Date.now();
let res = await client.callTool({
  name: 'comfy_run',
  arguments: {
    template: 'flux_t2i',
    params: { prompt: 'a red apple on a wooden table, product photo', width: 512, height: 512, steps: 4, seed: 7, filename_prefix: 'smoke/test' },
    wait_s: 1,          // 故意只等 1 秒，强制走 pending 分支
    view: 'none',
  },
});
let data = parse(res);
check('首次调用返回 pending（长任务被切成小段）', data.pending === true, JSON.stringify(data).slice(0, 300));
check('pending 时带 prompt_id', typeof data.prompt_id === 'string' && data.prompt_id.length > 10);

let polls = 0;
while (data.pending && polls < 12) {
  await sleep(1500);
  data = parse(await client.callTool({ name: 'comfy_wait', arguments: { prompt_id: data.prompt_id, wait_s: 25 } }));
  polls++;
}
check('轮询后拿到成功结果', data.ok === true && !data.error, JSON.stringify(data).slice(0, 400));
check('产物有文件名', typeof data.outputs?.[0]?.filename === 'string');
check('产物有质量指标', typeof data.outputs?.[0]?.quality?.lap_var_512 === 'number');
check('512 被判为低于原生分辨率', (data.outputs?.[0]?.quality?.verdict?.flags || []).includes('below_native'));
check('算出了耗时', typeof data.outputs?.[0]?.bytes === 'number' && data.outputs[0].bytes > 1000);

const wall = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n总耗时 ${wall}s，轮询 ${polls} 次`);
console.log(`产物：${data.outputs?.[0]?.path}`);
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
await client.close();
process.exit(failed ? 1 : 0);
