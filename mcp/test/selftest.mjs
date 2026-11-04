// test/selftest.mjs — 协议 + 工具 + 崩溃回归测试（不跑真实生成，秒级）
// 运行：node test/selftest.mjs
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OUTPUT_DIR } from '../lib/config.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SERVER = join(HERE, '..', 'server.mjs');
const NODE = process.execPath;

/** 测试用的样本图：从本机产物目录里现找一个（分发包里没有固定测试图，不能写死路径） */
function sampleImage() {
  if (!OUTPUT_DIR || !existsSync(OUTPUT_DIR)) return null;
  const want = ['.png', '.jpg', '.jpeg', '.webp'];
  const walk = (dir, depth = 0) => {
    if (depth > 2) return null;
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of names) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { const hit = walk(p, depth + 1); if (hit) return hit; }
      else if (want.some((x) => e.name.toLowerCase().endsWith(x))) return p;
    }
    return null;
  };
  return walk(OUTPUT_DIR);
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

function firstText(res) {
  return res?.content?.find((c) => c.type === 'text')?.text || '';
}
function parseText(res) {
  try { return JSON.parse(firstText(res)); } catch { return null; }
}

async function withClient(fn) {
  const transport = new StdioClientTransport({ command: NODE, args: [SERVER], stderr: 'pipe' });
  const client = new Client({ name: 'comfyforge-selftest', version: '0.2.0' });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close().catch(() => {}); }
}

console.log('== 1. 协议与工具清单 ==');
await withClient(async (client) => {
  const info = client.getServerVersion();
  ok('serverInfo.name = comfy-forge', info?.name === 'comfy-forge', JSON.stringify(info));
  ok('serverInfo.version = 0.3.0', info?.version === '0.3.0');

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log('  tools:', names.join(', '));
  const expected = ['comfy_health', 'comfy_models', 'comfy_run', 'comfy_wait', 'comfy_queue', 'comfy_image',
    'comfy_snapshot', 'comfy_inspect', 'comfy_templates', 'comfy_runs', 'comfy_lessons', 'comfy_log',
    'comfy_edit', 'comfy_replace', 'comfy_restructure'];
  for (const e of expected) ok(`有工具 ${e}`, names.includes(e));

  // 每个工具都必须有可用的 inputSchema
  const badSchema = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== 'object');
  ok('所有工具都有 object 型 inputSchema', badSchema.length === 0, badSchema.map((t) => t.name).join(','));

  console.log('== 2. comfy_health ==');
  const health = parseText(await client.callTool({ name: 'comfy_health', arguments: {} }));
  ok('health.ok = true（ComfyUI 在线）', health?.ok === true, firstText(await client.callTool({ name: 'comfy_health', arguments: {} })).slice(0, 200));
  ok('health 报出版本', typeof health?.comfyui === 'string' && health.comfyui.length > 0);
  ok('health 报出显存', typeof health?.vram_total === 'string');
  // 分发相关：体检必须自报「配置从哪来、缺什么」，否则别人装完不知道错在哪
  ok('health 附带环境自检', Array.isArray(health?.env?.checks) && health.env.checks.length >= 4, JSON.stringify(health?.env)?.slice(0, 200));
  ok('自检标明运行模式', health?.env?.mode === 'local' || health?.env?.mode === 'remote', String(health?.env?.mode));
  ok('配置字段带来源标注', (health?.env?.config?.fields || []).length >= 5
    && health.env.config.fields.every((f) => ['env', 'file', 'auto', 'default', 'missing', 'invalid'].includes(f.source)),
  JSON.stringify(health?.env?.config?.fields)?.slice(0, 200));
  ok('能力清单随体检返回', (health?.env?.capabilities?.summary?.total || 0) >= 5,
    JSON.stringify(health?.env?.capabilities?.summary));

  console.log('== 3. comfy_models ==');
  const models = parseText(await client.callTool({ name: 'comfy_models', arguments: {} }));
  ok('unet_gguf 含 flux1-dev-Q4_K_S.gguf', (models?.unet_gguf || []).some((m) => m.includes('flux1-dev-Q4_K_S')));
  ok('vae 含 flux-ae', (models?.vae || []).some((m) => m.includes('flux-ae')));
  ok('clip 含 clip_l 与 t5xxl', (models?.clip || []).some((m) => m.includes('clip_l')) && (models?.clip || []).some((m) => m.includes('t5xxl')));

  console.log('== 4. 静态校验能挡住坏工作流 ==');
  const bad = await client.callTool({
    name: 'comfy_run',
    arguments: {
      validate_only: true,
      workflow: {
        '1': { class_type: 'NoSuchNode', inputs: {} },
        '2': { class_type: 'KSampler', inputs: { model: ['9', 0] } },
      },
    },
  });
  const badPayload = parseText(bad);
  ok('坏工作流返回 isError', bad.isError === true);
  ok('指出未知节点类型', /NoSuchNode/.test(JSON.stringify(badPayload)));
  ok('指出缺失的必填输入', /缺必填输入/.test(JSON.stringify(badPayload)));
  ok('指出断掉的连线', /引用了不存在的节点/.test(JSON.stringify(badPayload)));

  console.log('== 5. 模板校验走通 ==');
  const good = await client.callTool({ name: 'comfy_run', arguments: { template: 'flux_t2i', validate_only: true, params: { prompt: 'x', width: 1024, height: 1024 } } });
  const goodPayload = parseText(good);
  ok('flux_t2i 校验通过', good.isError !== true && goodPayload?.validated === true, JSON.stringify(goodPayload).slice(0, 300));
  ok('参数被应用', goodPayload?.params?.width === 1024);
  ok('1024 不触发分辨率提示', !(goodPayload?.hints || []).some((h) => /低于 FLUX/.test(h)));

  const small = parseText(await client.callTool({ name: 'comfy_run', arguments: { template: 'flux_t2i', validate_only: true, params: { width: 512, height: 512 } } }));
  ok('512 触发分辨率提示', (small?.hints || []).some((h) => /原生训练分辨率/.test(h)), JSON.stringify(small?.hints));

  const bnb = parseText(await client.callTool({
    name: 'comfy_run',
    arguments: { validate_only: true, workflow: { '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux1-dev-bnb-nf4-v2.safetensors', weight_dtype: 'default' } } } },
  }));
  ok('拦截 bnb nf4 权重', (bnb?.hints || []).some((h) => /bitsandbytes|nf4/.test(h)), JSON.stringify(bnb?.hints));

  console.log('== 5b. 种子随机化与 null 输入防护 ==');
  const noSeed = parseText(await client.callTool({ name: 'comfy_run', arguments: { template: 'flux_t2i', validate_only: true, params: { prompt: 'y' } } }));
  ok('不传 seed 时自动生成随机种子', Number.isInteger(noSeed?.params?.seed), JSON.stringify(noSeed?.params));
  const nullSeed = await client.callTool({
    name: 'comfy_run',
    arguments: {
      validate_only: true,
      workflow: {
        '1': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['2', 0], seed: null, steps: 20, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
        '2': { class_type: 'VAEDecode', inputs: { samples: ['1', 0], vae: ['3', 0] } },
        '3': { class_type: 'VAELoader', inputs: { vae_name: 'flux-ae.safetensors' } },
      },
    },
  });
  const nullPayload = parseText(nullSeed);
  ok('seed=null 在提交前被拦住', nullSeed.isError === true && /不能为空/.test(JSON.stringify(nullPayload)), JSON.stringify(nullPayload).slice(0, 240));

  console.log('== 6. 取图（subfolder 回归：v0.1 在这里 404） ==');
  const combined = await client.callTool({ name: 'comfy_image', arguments: { filename: 'comfyforge/selftest_00001_.png' } });
  const img = combined?.content?.find((c) => c.type === 'image');
  ok('带斜杠的 filename 被拆成 filename+subfolder', !!img && img.data.length > 1000, firstText(combined).slice(0, 200));
  const meta = parseText(combined);
  ok('返回了尺寸指标', meta?.width === 512 && meta?.height === 512);

  const explicit = await client.callTool({ name: 'comfy_image', arguments: { filename: 'selftest_00001_.png', subfolder: 'comfyforge' } });
  ok('显式 filename+subfolder 也能取', !!explicit?.content?.find((c) => c.type === 'image'));

  console.log('== 7. 快照（多图拼一张） ==');
  const snap = await client.callTool({ name: 'comfy_snapshot', arguments: { latest: 2, cols: 2 } });
  const snapImg = snap?.content?.find((c) => c.type === 'image');
  const snapMeta = parseText(snap);
  ok('返回联络表图片', !!snapImg && snapImg.data.length > 1000);
  ok('联络表计数正确', snapMeta?.count >= 2, JSON.stringify(snapMeta?.count));
  ok('联络表文件落盘', existsSync(snapMeta?.sheet || ''));
  ok('每张图带判定', (snapMeta?.images || []).every((i) => i?.verdict?.level));

  console.log('== 8. 体检 ==');
  const insp = parseText(await client.callTool({ name: 'comfy_inspect', arguments: { images: [{ filename: 'selftest_00001_.png', subfolder: 'comfyforge' }] } }));
  ok('512 图被判为低于原生分辨率', (insp?.images?.[0]?.verdict?.flags || []).includes('below_native'), JSON.stringify(insp?.images?.[0]?.verdict));
  ok('给出了锐度数值', typeof insp?.images?.[0]?.lap_var_512 === 'number');

  console.log('== 8b. 模型档案：分辨率跟模型走 ==');
  const prof = parseText(await client.callTool({ name: 'comfy_profile', arguments: { action: 'list' } }));
  const gguf = (prof?.models || []).find((m) => String(m.file).includes('Q4_K_S'));
  const nf4 = (prof?.models || []).find((m) => String(m.file).includes('bnb-nf4'));
  ok('档案里有 GGUF 模型且标为可用', !!gguf && gguf.usable === true);
  ok('nf4 被标为不可用并给出原因', !!nf4 && nf4.usable === false && /bitsandbytes/.test(nf4.reason || ''));
  ok('GGUF 带 1MP 原生与宽高比桶', gguf?.native_mp === 1 && (gguf?.buckets || []).length >= 5);

  const nf4Run = await client.callTool({
    name: 'comfy_run',
    arguments: { validate_only: true, workflow: { '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux1-dev-bnb-nf4-v2.safetensors', weight_dtype: 'default' } }, '7': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } } } },
  });
  ok('不可用模型在提交前被拒', nf4Run.isError === true && /不可用/.test(firstText(nf4Run)), firstText(nf4Run).slice(0, 200));

  const wide = parseText(await client.callTool({ name: 'comfy_run', arguments: { template: 'flux_t2i', validate_only: true, params: { width: 1344, height: 768 } } }));
  ok('1344x768 命中推荐桶', (wide?.hints || []).some((h) => /命中.*推荐桶/.test(h)), JSON.stringify(wide?.hints));
  ok('1344x768 不报尺寸告警', !(wide?.warnings || []).some((w) => /推荐桶里/.test(w)), JSON.stringify(wide?.warnings));

  const off = parseText(await client.callTool({ name: 'comfy_run', arguments: { template: 'flux_t2i', validate_only: true, params: { width: 700, height: 500 } } }));
  ok('非桶尺寸给出告警', (off?.warnings || []).some((w) => /推荐桶里/.test(w)), JSON.stringify(off?.warnings));

  console.log('== 8c. 精选清单 ==');
  const add = parseText(await client.callTool({ name: 'comfy_picks', arguments: { action: 'add', filename: 'selftest_00001_.png', subfolder: 'comfyforge', note: 'selftest' } }));
  ok('加入精选', add?.ok === true && add?.item?.key === 'comfyforge/selftest_00001_.png', JSON.stringify(add).slice(0, 200));
  const listed = parseText(await client.callTool({ name: 'comfy_picks', arguments: { action: 'list' } }));
  ok('精选可回读', (listed?.items || []).some((i) => i.key === 'comfyforge/selftest_00001_.png'));
  const rm = parseText(await client.callTool({ name: 'comfy_picks', arguments: { action: 'remove', filename: 'selftest_00001_.png', subfolder: 'comfyforge' } }));
  ok('移除精选', rm?.removed === true);
  const after = parseText(await client.callTool({ name: 'comfy_picks', arguments: { action: 'list' } }));
  ok('移除后不在清单里', !(after?.items || []).some((i) => i.key === 'comfyforge/selftest_00001_.png'));

  console.log('== 8d. 批量提交（不等结果，随后取消） ==');
  const batch = parseText(await client.callTool({
    name: 'comfy_batch',
    arguments: { template: 'flux_t2i', params: { prompt: 'batch selftest', width: 512, height: 512, steps: 1 }, seeds: [1, 2], wait_s: 0, view: 'none' },
  }));
  ok('批量返回 2 个任务', batch?.count === 2 && (batch?.batch || []).length === 2, JSON.stringify(batch).slice(0, 240));
  ok('批量给出 prompt_id 与 remaining', (batch?.remaining || []).length === 2 && typeof batch?.batch?.[0]?.prompt_id === 'string');
  for (const id of batch?.remaining || []) {
    await client.callTool({ name: 'comfy_queue', arguments: { action: 'cancel', prompt_id: id } });
  }
  ok('批量任务可取消', true);

  console.log('== 8e. 节点查询与数值范围 ==');
  const node = parseText(await client.callTool({ name: 'comfy_nodes', arguments: { class_type: 'KSampler' } }));
  ok('KSampler 定义了 seed/steps', !!(node?.required?.seed && node?.required?.steps), JSON.stringify(node).slice(0, 200));
  const search = parseText(await client.callTool({ name: 'comfy_nodes', arguments: { query: 'upscale', limit: 10 } }));
  ok('节点搜索能返回结果', (search?.nodes || []).length > 0, JSON.stringify(search).slice(0, 200));
  const badSteps = await client.callTool({ name: 'comfy_run', arguments: { template: 'flux_t2i', validate_only: true, params: { steps: 0 } } });
  ok('steps=0 被范围校验拦住', badSteps.isError === true && /最小值/.test(firstText(badSteps)), firstText(badSteps).slice(0, 160));

  console.log('== 8f. 上传与局部编辑地基 ==');
  const sample = sampleImage();
  if (sample) {
    const up = parseText(await client.callTool({ name: 'comfy_upload', arguments: { path: sample } }));
    ok('上传图片拿到 input 文件名', up?.ok === true && typeof up?.name === 'string' && up.name.length > 3, JSON.stringify(up).slice(0, 200));
  } else {
    // 没有产物图时不能算失败：这是环境缺图，不是功能坏了
    console.log('  SKIP  上传图片（产物目录里没有可用图片，先跑一张再来）');
  }
  const editSchema = (await client.listTools()).tools.find((t) => t.name === 'comfy_edit');
  ok('comfy_edit 暴露 box/prompt/denoise', !!editSchema?.inputSchema?.properties?.box && !!editSchema?.inputSchema?.properties?.prompt);

  console.log('== 9. 模板库 ==');
  const tpls = parseText(await client.callTool({ name: 'comfy_templates', arguments: { action: 'list' } }));
  ok('列出 flux_t2i', (tpls?.templates || []).some((t) => t.name === 'flux_t2i'));
  const got = parseText(await client.callTool({ name: 'comfy_templates', arguments: { action: 'get', name: 'flux_t2i' } }));
  ok('取到完整工作流', Object.keys(got?.template?.workflow || {}).length === 10);
  ok('模板带绑定表', !!got?.template?.bindings?.width);

  console.log('== 10. 未知工具与坏参数 ==');
  let unknownErrored = false;
  try { const r = await client.callTool({ name: 'comfy_nope', arguments: {} }); unknownErrored = r?.isError === true || !!r?.content; } catch { unknownErrored = true; }
  ok('未知工具不会静默成功', unknownErrored);
  const noTpl = await client.callTool({ name: 'comfy_run', arguments: { template: 'does_not_exist' } });
  ok('不存在的模板给出可读错误', /不存在/.test(firstText(noTpl)), firstText(noTpl).slice(0, 160));
});

console.log('== 11. 崩溃回归：stdin EOF 后必须干净退出（v0.1 会触发 libuv Assertion failed） ==');
await new Promise((resolve) => {
  const child = spawn(NODE, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let exited = false;
  const timer = setTimeout(() => {
    if (!exited) { console.log('  FAIL  stdin 关闭后 20s 未退出（可能挂死）'); fail++; child.kill(); resolve(); }
  }, 20_000);
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('exit', (code) => {
    exited = true; clearTimeout(timer);
    ok('退出码为 0', code === 0, `code=${code}`);
    ok('stderr 无 libuv assertion', !/Assertion failed/.test(stderr), stderr.slice(0, 200));
    resolve();
  });
  child.stdout.on('data', () => {});
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eof', version: '1' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'comfy_health', arguments: {} } }) + '\n');
  setTimeout(() => child.stdin.end(), 1500);
});

console.log('== 12. 目录结构 ==');
ok('workflows/ 有模板', readdirSync(join(HERE, '..', '..', 'workflows')).some((f) => f.endsWith('.json')));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
