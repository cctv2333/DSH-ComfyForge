// test/unit.mjs —— lib 纯函数单测（不需要 ComfyUI、不需要出图，秒级）
// 运行：node test/unit.mjs
//
// 和 selftest.mjs 的分工：
//   selftest  端到端：起 MCP 服务、调工具、验协议
//   unit      纯函数：解析、判定、边界值 —— 重构时先在这里红，比端到端红好定位
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { framesFor, buildH3Pass2Workflow } from '../lib/video.mjs';
import { checkRequirements } from '../lib/requires.mjs';
import { analyzeModelSlots, findModelSlots } from '../lib/modelslots.mjs';
import { extractTypes } from '../lib/workflowcheck.mjs';
import { guessFamily, profileFor } from '../lib/models.mjs';
import { scan as triageScan } from '../lib/triage.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};
const tmp = (label) => mkdtempSync(join(tmpdir(), `cf-unit-${label}-`));

console.log('== 1. 帧数换算（H3 的 5+17k） ==');
ok('15 秒 → 362 帧', framesFor(15).frames === 362, JSON.stringify(framesFor(15)));
ok('返回的帧数满足 5+17k', [1, 5, 8, 15, 30].every((s) => framesFor(s).frames % 17 === 5), JSON.stringify([1, 5, 8, 15, 30].map((s) => framesFor(s).frames)));
ok('帧数永不小于 5', framesFor(0.1).frames >= 5, JSON.stringify(framesFor(0.1)));
ok('实际时长按时长换算（24fps）', Math.abs(framesFor(15).seconds - 362 / 24) < 0.01, String(framesFor(15).seconds));
ok('连续时长单调不减', framesFor(10).frames >= framesFor(9).frames);

console.log('== 2. 模型槽位解析 ==');
{
  const g = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'a.gguf' } },
    2: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 1 } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'b.safetensors' } },
  };
  const slots = findModelSlots(g);
  ok('只取模型槽位（不受连线数组干扰）', slots.length === 2, JSON.stringify(slots.map((s) => s.key)));
  ok('识别 unet_name / vae_name', slots.some((s) => s.key === 'unet_name') && slots.some((s) => s.key === 'vae_name'));
  const r = analyzeModelSlots(g, { root: null });
  ok('无 comfyRoot 时状态为 unknown 而不是 ok', r.slots.every((s) => s.status === 'unknown'));
  ok('summary 计数完整', r.summary.unknown === 2);
}

console.log('== 3. 体积校验（0 字节占位文件不能算"有"） ==');
{
  const root = tmp('size');
  mkdirSync(join(root, 'models', 'diffusion_models'), { recursive: true });
  // 名字匹配 H3 主模型（应约 19.5GB），但只有 1KB
  writeFileSync(join(root, 'models', 'diffusion_models', 'minimax_h3_fake.safetensors'), 'x');
  const rows = checkRequirements({ nodes: new Set(), comfyRoot: root, hasBin: () => true });
  const cap = rows.find((r) => r.id === 'video-single');
  const modelMiss = (cap?.missing || []).find((m) => m.kind === 'model' && /主模型/.test(m.what));
  ok('残文件被判为缺件', !!modelMiss, JSON.stringify(cap?.missing?.map((m) => m.what)));
  ok('缺件说明里指出体积不符', !!modelMiss && /体积不符|没下完/.test(modelMiss.how), modelMiss?.how);
  ok('缺件带来源与许可字段', !!modelMiss?.source?.hint && !!modelMiss?.source?.license, JSON.stringify(modelMiss?.source));
  rmSync(root, { recursive: true, force: true });
}

console.log('== 4. 工作流节点类型抽取 ==');
{
  const ui = { nodes: [{ type: 'KSampler' }, { type: 'Reroute' }, { type: 'VAEDecode' }] };
  const t1 = extractTypes(ui);
  ok('UI 格式能抽类型', t1.has('KSampler') && t1.has('VAEDecode'));
  ok('忽略 Reroute 这类纯界面节点', !t1.has('Reroute'));
  const api = { 1: { class_type: 'CLIPTextEncode', inputs: {} }, 2: { class_type: 'KSampler', inputs: {} } };
  const t2 = extractTypes(api);
  ok('API 格式能抽类型', t2.has('CLIPTextEncode') && t2.size === 2);
}

console.log('== 5. 模型家族与分辨率桶 ==');
{
  ok('gguf → flux 家族', guessFamily('flux1-dev-Q4_K_S.gguf') === 'flux', guessFamily('flux1-dev-Q4_K_S.gguf'));
  ok('illustrious → sdxl 系', /illustrious|sdxl/i.test(String(guessFamily('waiNSFWIllustrious_v130.safetensors'))), String(guessFamily('waiNSFWIllustrious_v130.safetensors')));
  const p = profileFor('waiNSFWIllustrious_v130.safetensors');
  ok('档案里有原生分辨率/桶信息', !!p && (p.native_mp != null || Array.isArray(p.buckets)), JSON.stringify(p)?.slice(0, 120));
}

console.log('== 6. 淘汰扫描认得视频（坏文件必须被挑出来） ==');
{
  const dir = tmp('triage');
  writeFileSync(join(dir, 'broken.mp4'), ''); // 0 字节
  writeFileSync(join(dir, 'note.txt'), 'x');  // 不是媒体，应被忽略
  const r = triageScan(dir);
  ok('只扫媒体文件', r.total === 1, String(r.total));
  ok('空视频被判为垃圾', r.rejected.length === 1 && /unreadable|too small/.test(r.rejected[0].reasons.join(' ')));
  ok('返回里标注了 kind', r.rejected[0]?.kind === 'video', JSON.stringify(r.rejected[0]));
  rmSync(dir, { recursive: true, force: true });
}

console.log('== 7. 域文件必须解构它用到的 ctx 导出 ==');
{
  // 拆 server.mjs 时踩过的坑（2026-11-06 实锤）：
  //   media.mjs 用了 inputDir / resolveVideoPath，system.mjs 用了 ACTIVITY，
  //   但解构表里没有 → 工具一调就 ReferenceError，而 `node --check` 查不出来、
  //   import 也不报错（错在回调体内，只有真调用才炸）。
  // 结果 comfy_video / comfy_activity 静默坏掉，80 项 selftest 全绿也没抓到。
  // 这里只查长度 >=4 的名字：J / gb / text 这类短名会误伤字符串和注释。
  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools');
  const ctxSrc = readFileSync(join(toolsDir, 'ctx.mjs'), 'utf8');
  const m = ctxSrc.match(/export\s*\{([^}]+)\}/);
  const exps = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  ok('ctx.mjs 能解析出导出表', exps.length > 20, String(exps.length));

  const longNames = exps.filter((e) => e.length >= 4);
  const problems = [];
  const files = readdirSync(toolsDir).filter((f) => f.endsWith('.mjs') && f !== 'ctx.mjs');
  ok('tools 下有域文件', files.length >= 6, files.join(','));
  for (const name of files) {
    const src = readFileSync(join(toolsDir, name), 'utf8');
    const dm = src.match(/const\s*\{([\s\S]*?)\}\s*=\s*C;/);
    const declared = dm ? dm[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    for (const e of longNames) {
      if (declared.includes(e)) continue;
      if (new RegExp(`^import[^;]*\\b${e}\\b`, 'm').test(src)) continue;
      if (new RegExp(`^\\s*(const|let|function|class)\\s+${e}\\b`, 'm').test(src)) continue;
      if (new RegExp(`\\b${e}\\b`).test(src)) problems.push(`${name}:${e}`);
    }
  }
  ok('没有「用了但没解构」的 ctx 导出', problems.length === 0, problems.join(' '));
}

console.log('== 8. 二采默认路径（2026-11-06 实炸过一次，防回归）==');
{
  // 一采只跑 8 步时，output([0]) 还是 σ≈0.6 的半成品；3D 放大网络按干净 latent 的
  // 统计做归一化，喂半成品会把噪声放大成**彩色碎片**（满屏方块+白色锯齿轮廓）。
  // 必须取 SamplerCustomAdvanced 的 denoised_output([1])——用户的参考工作流一直如此。
  // 同一天还犯过第二个错：只改了 SplitSigmas 却没改这里，结果"音频好了、画面碎了"。
  const wf = buildH3Pass2Workflow({ image: 'x.png', prompt: 't', width: 320, height: 320, length: 124, seed: 1 }).workflow;
  ok('一采拆 AV 取 denoised_output', JSON.stringify(wf['16'].inputs.av_latent) === '["15",1]', JSON.stringify(wf['16'].inputs.av_latent));
  ok('一采用 SplitSigmas 前半', JSON.stringify(wf['15'].inputs.sigmas) === '["13",0]', JSON.stringify(wf['15'].inputs.sigmas));
  ok('二采用 SplitSigmas 后半', JSON.stringify(wf['21'].inputs.sigmas) === '["13",1]', JSON.stringify(wf['21'].inputs.sigmas));
  ok('默认不含独立调度节点 30', wf['30'] === undefined);
  const risky = buildH3Pass2Workflow({ image: 'x.png', prompt: 't', width: 320, height: 320, length: 124, seed: 1, refineDenoise: 0.35 });
  ok('显式 refine 时给出音频风险警告', typeof risky.meta.audioRisk === 'string' && risky.meta.audioRisk.length > 10);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
