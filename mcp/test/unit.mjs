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
import { presenceFromQueue, QueuePresenceCache, MissingTaskTracker, MISSING_TASK_POLICY } from '../lib/comfypolling.mjs';
import { validateH3Prompt, splitSections, formatH3Problems, FIELDS_FULL, FIELDS_BASE } from '../lib/h3protocol.mjs';
import { readReferenceImageOrders, resolvePictureNumbers } from '../lib/h3refs.mjs';
import { PROJECT_ROOT } from '../lib/config.mjs';

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

console.log('\n== 9. /queue 在场信息：「缺席 ≠ 失败」 ==');
{
  const q = {
    queue_running: [[0, 'run-1', {}, { client_id: 'c1' }, []]],
    queue_pending: [[1, 'pend-1', {}, {}, []], [2, 'pend-2', {}, {}, []]],
  };
  const p = presenceFromQueue(q);
  ok('/queue 只留 id 与状态', p.valid && p.runningIds.has('run-1') && p.pendingIds.size === 2, JSON.stringify([...p.pendingIds]));
  ok('待跑顺序保序', JSON.stringify(p.pendingOrder) === '["pend-1","pend-2"]', JSON.stringify(p.pendingOrder));
  ok('client_id → 任务id 映射', p.taskIdByClient.get('c1') === 'run-1');
  ok('坏行判为无效快照', presenceFromQueue({ queue_running: [[0]], queue_pending: [] }).valid === false);

  // 缓存：同一 scope 的一次读取被共享（并发 3 次只发 1 个请求）
  let loads = 0;
  const cache = new QueuePresenceCache();
  const load = async () => { loads++; await new Promise((r) => setTimeout(r, 10)); return q; };
  const [a, b, c] = await Promise.all([cache.get('s', load), cache.get('s', load), cache.get('s', load)]);
  ok('并发读取只发一次请求', loads === 1, String(loads));
  ok('共享同一份结果', a === b && b === c && a.observationId > 0);

  const tr = new MissingTaskTracker();
  const now = Date.now();
  const fresh = { valid: true, observationId: 1 };
  ok('任务还年轻 → 不下结论', tr.observe('t1', now - 60_000, fresh, now) === false);
  // 有效观测 6 次、跨度 2 分钟、任务已 40 分钟 → 才判定「它真的不在了」
  let judged = false;
  for (let i = 0; i < MISSING_TASK_POLICY.minimumObservations; i += 1) {
    judged = tr.observe('t2', now - 40 * 60_000, { valid: true, observationId: 10 + i }, now + i * 25_000);
  }
  ok('6 次观测 + 2 分钟跨度 → 判为不在', judged === true);
  // 只有 5 次（跨度够）不该判定
  let judgedFew = false;
  for (let i = 0; i < MISSING_TASK_POLICY.minimumObservations - 1; i += 1) {
    judgedFew = tr.observe('t5', now - 40 * 60_000, { valid: true, observationId: 50 + i }, now + i * 30_000);
  }
  ok('观测次数不够 → 不判定', judgedFew === false);
  const one = { valid: true, observationId: 99 };
  tr.observe('t3', now - 40 * 60_000, one, now);
  ok('同一份快照重复观测不重复计数', tr.observe('t3', now - 40 * 60_000, one, now + 60_000) === false);
  ok('无效快照不计数', tr.observe('t4', now - 40 * 60_000, { valid: false, observationId: 5 }, now) === false);
}

console.log('\n== 10. H3 提示词结构校验（官方协议） ==');
{
  const base = [
    'integrated_multimodal_description: [Shot 1] Live-action, cinematic, a woman (S1) says: <d>[English] Hi.</d> [Shot 2] At 00:03.000, the shot cuts to a close-up.',
    'overall_soundscape: Rain taps the window while room tone continues underneath.',
    'non_diegetic_music: N/A',
  ].join('\n\n');
  const r1 = validateH3Prompt(base);
  ok('三段式：字段与顺序正确', r1.mode === 'base' && r1.ok, JSON.stringify(r1.problems));
  ok('切点解析成秒', JSON.stringify(r1.shots.map((s) => s.at)) === '[null,3]', JSON.stringify(r1.shots));

  const full = [
    'subject_definitions:',
    '<Subject 1> is the woman in <Picture 1>.',
    '',
    'summary:',
    '[reference generation] The target video shows <Subject 1> walking.',
    '',
    'retention_analysis:',
    '<Subject 1> (appears in [Shot 1]): fully_preserved - identity retained.',
    '',
    'detailed_description:',
    '[Shot 1] The shot begins from <Picture 1>, <Subject 1> (S1) says: <d>[English] Hello.</d>',
    '',
    'overall_soundscape: Quiet room tone.',
    '',
    'non_diegetic_music: Sparse piano at a slow tempo.',
  ].join('\n');
  const r2 = validateH3Prompt(full);
  ok('六段式：字段、标签、retention 全对', r2.mode === 'full' && r2.ok, JSON.stringify(r2.problems));
  ok('段落切分保留顺序', JSON.stringify(splitSections(full).map((s) => s.name)) === JSON.stringify(FIELDS_FULL));

  const has = (res, code) => res.problems.some((p) => p.code === code);
  ok('负向字段 → 报错', has(validateH3Prompt(`negative_prompt: bad\n${base}`), 'negative'));
  ok('首镜带时间码 → 报错', has(validateH3Prompt(base.replace('[Shot 1] Live-action', '[Shot 1] At 00:01.000, Live-action')), 'shot1-at'));
  ok('第二镜切到 0 秒（与首镜同时）→ 报错', has(validateH3Prompt(base.replace('At 00:03.000', 'At 00:00.000')), 'cut-order'));
  ok('三镜里第二镜倒退 → 报错', has(validateH3Prompt(
    'integrated_multimodal_description: [Shot 1] a. [Shot 2] At 00:05.000, b. [Shot 3] At 00:03.000, c.\n\noverall_soundscape: x.\n\nnon_diegetic_music: N/A',
  ), 'cut-order'));
  ok('<d> 未闭合 → 报错', has(validateH3Prompt(base.replace('</d>', '')), 'dialogue-unclosed'));
  ok('字段顺序错 → 报错', has(validateH3Prompt(base.split('\n\n').reverse().join('\n\n')), 'fields'));
  ok('引用未定义标签 → 报错', has(validateH3Prompt(full.replace('shows <Subject 1>', 'shows <Subject 2>')), 'label-undefined'));
  ok('声源编号乱序 → 报错', has(validateH3Prompt(
    'integrated_multimodal_description: [Shot 1] a (S2) says: <d>[English] A.</d> [Shot 2] At 00:02.000, b (S1) says: <d>[English] B.</d>\n\noverall_soundscape: x.\n\nnon_diegetic_music: N/A',
  ), 'speaker-order'));
  ok('retention 标记不合法 → 报错', has(validateH3Prompt(full.replace('fully_preserved', 'kept')), 'retention-marker'));
  ok('soundscape 写成逐镜清单 → 告警', has(validateH3Prompt(base.replace('overall_soundscape: Rain taps the window while room tone continues underneath.', 'overall_soundscape: Shot 1 — rain. Shot 2 — bell.')), 'soundscape-per-shot'));
  ok('配乐写抽象情绪词 → 告警', has(validateH3Prompt(base.replace('Sparse piano at a slow tempo.', 'N/A').replace('N/A', 'A sad emotional piano at a slow tempo.')), 'music-mood'));
  ok('问题清单渲染带位置不带正文', formatH3Problems(validateH3Prompt('negative: x').problems).includes('[error]'));

  // 空输入与 NaN 边界
  ok('空提示词 → 报错而不是崩', validateH3Prompt('').ok === false);
  ok('校验器不因缺 durationSec 崩', validateH3Prompt(base, {}).ok === true);
}

console.log('\n== 11. <Picture n> 编号从图里推导 ==');
{
  const i2v = {
    5: { class_type: 'LoadImage', inputs: { image: 'front.png' } },
    17: { class_type: 'LoadImage', inputs: { image: 'last.png' } },
    6: { class_type: 'MiniMaxH3ImageToVideo', inputs: { first_frame: ['5', 0], last_frame: ['17', 0] } },
  };
  const orders = readReferenceImageOrders(i2v);
  ok('图生视频读到 2 张参考图', orders.length === 1 && orders[0].images.length === 2, JSON.stringify(orders));
  ok('顺序 = first_frame, last_frame', orders[0].images.map((i) => i.inputName).join(',') === 'first_frame,last_frame');
  ok('编号 1,2', JSON.stringify(resolvePictureNumbers(orders, [0, 1])) === '[1,2]');

  const r2v = {
    8: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
    18: { class_type: 'LoadImage', inputs: { image: 'b.png' } },
    9: {
      class_type: 'MiniMaxH3ReferenceToVideo',
      inputs: { 'ref_images.ref_image_0': ['8', 0], 'ref_images.ref_image_1': ['18', 0] },
    },
  };
  const o2 = readReferenceImageOrders(r2v);
  ok('全参考读到 2 张', o2[0].images.length === 2, JSON.stringify(o2[0].images.map((i) => i.inputName)));
  ok('编号按 ref_image_N 顺序', JSON.stringify(resolvePictureNumbers(o2, [0, 1])) === '[1,2]');
  ok('只选第 2 张 → 编号 2', JSON.stringify(resolvePictureNumbers(o2, [1])) === '[2]');

  // 经过单图操作仍能追到 LoadImage
  const chained = {
    8: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
    30: { class_type: 'ImageScale', inputs: { image: ['8', 0] } },
    9: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { 'ref_images.ref_image_0': ['30', 0] } },
  };
  ok('穿过单图操作追到源', JSON.stringify(resolvePictureNumbers(readReferenceImageOrders(chained), [0])) === '[1]');

  // 未知节点（开关/批量）→ 不猜
  const unknown = {
    40: { class_type: 'SomeSwitch', inputs: {} },
    9: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { 'ref_images.ref_image_0': ['40', 0] } },
  };
  ok('来源不确定 → undefined（不猜）', resolvePictureNumbers(readReferenceImageOrders(unknown), [0]) === undefined);

  // 同一张图喂两个槽 → 编号不唯一
  const dup = {
    5: { class_type: 'LoadImage', inputs: { image: 'same.png' } },
    6: { class_type: 'MiniMaxH3ImageToVideo', inputs: { first_frame: ['5', 0], last_frame: ['5', 0] } },
  };
  ok('一图两用 → undefined', resolvePictureNumbers(readReferenceImageOrders(dup), [0, 1]) === undefined);

  ok('空选择 → 空数组', JSON.stringify(resolvePictureNumbers(orders, [])) === '[]');
  ok('槽位越界 → undefined', resolvePictureNumbers(orders, [5]) === undefined);
}

console.log('\n== 12. 仓库里不能有写死的本机绝对路径 ==');
{
  // 为什么要有这一组：用户 2026-11-06 的原话是「怕的是这个硬编码写死我电脑的环境」。
  // 这类值在别人机器上不会报错，只会**静默失效**（面板不出现、产物为空），
  // 所以必须由测试来守，而不是靠人记。工具在 tools/check-hardcoded.mjs，
  // 已实测能抓到当年那个 'D:\\vidlens\\...\\ffmpeg.exe'（双反斜杠写法也要认）。
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [join(PROJECT_ROOT, 'tools', 'check-hardcoded.mjs')], { encoding: 'utf8' });
  ok('check-hardcoded 能跑起来', typeof r.stdout === 'string' && r.stdout.length > 0);
  ok('代码里没有写死的本机绝对路径', r.status === 0, (r.stdout || '').split('\n').slice(0, 6).join(' | '));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);