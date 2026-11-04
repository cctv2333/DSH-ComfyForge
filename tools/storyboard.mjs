#!/usr/bin/env node
// tools/storyboard.mjs —— 故事 → 分镜图 + 配对的六段式提示词（一次出两半）
//
// 为什么是"一次生成一张分镜图"，而不是"逐格生成再拼"：
//   实测里那条被用户认可的成片，它的参考图是一张 12 格漫画页（1024×1536）。
//   同一张图里的角色天然一致 —— 这是"拼图"方案永远做不到的（跨图锁人物是另一门手艺）。
//   所以默认一次生成，`--mode panels` 留给"格子太多、一张画不下"的情况。
//
// 产出两样东西（缺一样，H3 那边就白跑）：
//   1) 分镜图 sb.png        —— 喂给 MiniMaxH3ReferenceToVideo 当 <Picture 1>
//   2) 六段式提示词 sb.txt  —— subject_definitions / summary / retention_analysis /
//                              detailed_description（含 [Shot] 时间码）/ overall_soundscape /
//                              non_diegetic_music
//
// 用法：
//   node tools/storyboard.mjs --shots shots.txt --char char.txt --out .cache/sb --panels 6
//   node tools/storyboard.mjs --story story.txt --char char.txt --shots 6 --out .cache/sb
//
// shots.txt 每行： 起点-终点 | 景别 | 动作 | 音效
//   00:00-00:02.5 | medium shot | 他推门走出，右手持铃，步伐平稳 | 瓷砖上的脚步声
//
// char.txt：角色设定（外形/服装/气质），会同时进图像提示词和视频提示词。

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';

const BASE = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const GW = process.env.DSH_WEB || 'http://127.0.0.1:63197';

// ---------------------------------------------------------------- 参数
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);

const shotsFile = arg('shots', null);
const charFile = arg('char', null);
const storyFile = arg('story', null);
const outBase = arg('out', '.cache/storyboard');
const panelCount = Number(arg('panels', '6'));
const mode = arg('mode', 'page'); // page | panels
const seed = Number(arg('seed', String(Math.floor(Math.random() * 1e9))));
const candidates = Number(arg('candidates', '3'));
const width = Number(arg('width', '832'));
const height = Number(arg('height', '1216'));
const steps = Number(arg('steps', '30'));
const dry = has('dry');

// ---------------------------------------------------------------- 读输入
function readText(p, label) {
  if (!p) return null;
  const f = resolve(p);
  if (!existsSync(f)) throw new Error(`${label} 文件不存在：${f}`);
  return readFileSync(f, 'utf8').replace(/^\uFEFF/, '').trim();
}

const charBlock = readText(charFile, '角色设定') || '';
const storyBlock = readText(storyFile, '故事');

/** 解析镜头表 */
function parseShots(text) {
  const shots = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 3) continue;
    const m = parts[0].match(/(\d{1,2}:\d{2}(?:\.\d+)?)\s*[-~–]\s*(\d{1,2}:\d{2}(?:\.\d+)?)/);
    if (!m) continue;
    shots.push({ start: m[1], end: m[2], framing: parts[1], action: parts[2], sound: parts[3] || '' });
  }
  return shots;
}

/** 没有镜头表时：把故事按句子均分成 N 段，每段给一个默认景别 */
function shotsFromStory(text, n) {
  const sents = text.split(/(?<=[。！？.!?])\s*/).map((s) => s.trim()).filter(Boolean);
  if (!sents.length) throw new Error('故事为空');
  const per = Math.ceil(sents.length / n);
  const framingPool = ['wide establishing shot', 'medium shot', 'close-up cut', 'medium shot', 'close-up cut', 'medium shot'];
  const secPer = 15 / n;
  const tc = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  return Array.from({ length: n }, (_, i) => ({
    start: tc(i * secPer),
    end: tc((i + 1) * secPer),
    framing: framingPool[i % framingPool.length],
    action: sents.slice(i * per, (i + 1) * per).join(' '),
    sound: '',
  }));
}

let shots = shotsFile ? parseShots(readText(shotsFile, '镜头表')) : shotsFromStory(storyBlock || '', panelCount);
if (!shots.length) throw new Error('镜头表解析出 0 条，检查格式：起点-终点 | 景别 | 动作 | 音效');
shots = shots.slice(0, panelCount);

// ---------------------------------------------------------------- 两套提示词
const STYLE = 'Japanese anime cel shading, clean crisp outlines, soft flat shading, cinematic dusk lighting';
// 图像提示词（SDXL 吃不了 6000 字符，只给"画面 + 版式"）
//
// 为什么会有 --compact：
//   SDXL / Illustrious 的文本编码在 77 token 处截断（≈300–350 字符）。
//   实测 1834 字符的完整提示词：版式被听懂了（6 格、有景别变化），
//   但后 6 条 panel 描述一个字也没进去 —— 角色变成"戴眼镜的少女"、场景变成室内。
//   所以"能塞多少"不等于"能听懂多少"。compact 模式只保留进了模型才有用的那部分。
const words = (s, n) => s.split(/[,，;；.。]+/).map((x) => x.trim()).filter(Boolean).slice(0, n).join(', ');
function imagePromptCompact() {
  const env = arg('env', 'a quiet urban corridor, cinematic dusk lighting');
  const charShort = words(charBlock, 5);
  // 77 token 的预算里，逐个 panel 的控制是放不下的（6 条描述就要 60+ token）。
  // 所以 compact 只保证"风格 + 场景 + 角色 + 是几格漫画"，格子内容交给模型。
  // 要逐格控制，用 --mode panels（每格一次短提示词生成，再拼）。
  // 顺序按"被截断时先丢谁"排：风格 → 环境 → 版式 → 角色。环境在第 2 位，因为它最容易被丢。
  return [
    'masterpiece, best quality, very aesthetic',
    'Japanese anime cel shading, clean outlines, flat shading',
    env,
    `comic page, ${shots.length} panels, thin black panel borders, sequential panels`,
    charShort,
    'no text, no speech bubbles',
  ].filter(Boolean).join(', ');
}

// 默认负面词里有 "comic" —— 它会直接压制"漫画页"版式（实测：版式出来了但气泡也跟着出来）。
// 分镜图要用这套专门的负面词：去掉 comic，强化去掉气泡与文字。
const NEG_STORYBOARD =
  'text, letters, words, watermark, signature, speech bubble, blank speech bubble, dialogue balloon, caption box, ' +
  'lowres, worst quality, low quality, jpeg artifacts, blurry, bad anatomy, bad hands, extra digits, realistic, photorealistic';
function imagePrompt() {
  if (has('compact')) return imagePromptCompact();
  const cols = shots.length <= 4 ? 2 : 3;
  const rows = Math.ceil(shots.length / cols);
  const lines = [
    'masterpiece, best quality, very aesthetic, absurdres',
    `comic page, storyboard sheet, ${shots.length} panels, ${rows} rows of ${cols}, thin black panel borders, sequential panels`,
    STYLE,
    'consistent character design across all panels, same face, same outfit',
    charBlock ? `character: ${charBlock}` : '',
    ...shots.map((s, i) => `panel ${i + 1}, ${s.framing}: ${s.action}`),
    'no text, no speech bubbles, no letters, no watermark',
  ];
  return lines.filter(Boolean).join(', ');
}
// 视频提示词（六段式，给 H3 r2v）
function videoPrompt() {
  const subj = charBlock || 'the same character in every shot';
  return `subject_definitions:
<Picture 1> is the reference comic storyboard, drawn as ${shots.length} sequential panels; it defines the character design, the shot order and the art style benchmark.
<Subject 1> ${subj}
Art style: ${STYLE}. Keep this style identical in every shot.

summary:
[reference generation] Follow <Picture 1> panel by panel, in order. Single continuous scene. ${storyBlock ? storyBlock + ' ' : ''}All special effects must stay locked to the actions described per shot.

retention_analysis:
<Subject 1> (all shots): fully_preserved — face, hair, outfit, accessories never change between shots.
<Picture 1> (style anchor, all shots): fully_preserved — outlines, shading and palette strictly follow the reference sheet.
Environment (all shots): fully_preserved — same location, same lighting, only framing changes.

detailed_description:
${STYLE}. Follow human hand rules: one hand holds only one prop at a time. No extra hands, no malformed fingers.
${shots
  .map(
    (s, i) =>
      `[Shot${i + 1}] ${s.start}-${s.end}, ${s.framing}: ${s.action}${s.sound ? `\nSound sync: ${s.sound}` : ''}`
  )
  .join('\n')}

overall_soundscape:
Quiet ambient tone runs underneath every shot. Every sound effect locks strictly to its matched action; no sound plays before or after its action.

non_diegetic_music:
Restrained cinematic BGM, low-key, follows the emotion of the sequence and fades out on the last shot.`;
}

// ---------------------------------------------------------------- 云端出图（默认路径）
//
// 为什么默认不再本地生成分镜页：
//   实测三代（见 WORK-0023）：本地 Illustrious 8GB / SDXL 在 77 token 预算下，
//   "角色 × 环境 × 6 个具体镜头"三角不可兼得 —— 给环境丢角色，给角色丢环境，去 comic 就回气泡。
//   用户那条被认可的分镜图是云端大模型出的。本地模型与云端在参数量、指令跟随、版式控制上不是一条路。
//   所以本工具的定位改成：**本地做提示词工程 + 接回云端出的图 + 直接喂 H3**。
//   本地生成保留在 --local（能出版式，控不住内容），不再当默认。
function buildCloudPrompt() {
  const env = arg('env', '（按你的剧本填：地点、时间、光线、天气）');
  const cols = shots.length <= 4 ? 2 : 3;
  const rows = Math.ceil(shots.length / cols);
  const lines = [];
  lines.push(`请为一段 ${shots.length} 个镜头的 AI 视频，画一张**分镜参考图**（不是单张插画，是一整张分镜页）。`);
  lines.push('');
  lines.push('【版式要求】');
  lines.push(`- 竖版 2:3，共 ${shots.length} 格，${rows} 行 × ${cols} 列，格与格之间细黑边框`);
  lines.push('- 所有格是同一场戏的连续镜头，按从左到右、从上到下阅读');
  lines.push('- 角色外形 / 服装 / 配色 / 光照在全图必须完全一致');
  lines.push('- 只画画面：**不要任何文字、对话气泡、拟声词、水印、署名、格子编号**');
  lines.push('');
  lines.push('【画风】');
  lines.push(STYLE);
  lines.push('');
  lines.push('【场景（全图统一）】');
  lines.push(env);
  lines.push('');
  if (charBlock) {
    lines.push('【角色设定】');
    lines.push(charBlock);
    lines.push('');
  }
  lines.push('【每格内容（严格按顺序，景别要跟着变）】');
  shots.forEach((s, i) => {
    lines.push(`第 ${i + 1} 格（${s.start}–${s.end}，${s.framing}）：${s.action}`);
  });
  lines.push('');
  lines.push('【自检】画完请确认：角色是否每格都是同一个人、场景是否每格都是同一处、是否出现了文字或气泡（出现就重画）。');
  return lines.join('\n');
}

// ---------------------------------------------------------------- 接回云端出的图
// 把用户拿回来的分镜图登记成"可直接跑 H3"的运行图：复制进 ComfyUI input，改引用，写 api.json。
// 支持多参考：--import 是分镜图（ref_image_0），--ref 可重复，追加三视图等设定图。
function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) out.push(process.argv[i + 1]);
  });
  return out;
}

function importImage(srcList, extraRefs = []) {
  const comfyInput = arg('comfy-input', process.env.COMFY_INPUT || (process.env.COMFY_ROOT ? join(process.env.COMFY_ROOT, 'input') : null));
  if (!comfyInput || !existsSync(comfyInput)) {
    throw new Error('找不到 ComfyUI 的 input 目录：加 --comfy-input "D:\\...\\ComfyUI\\input" 或设 COMFY_ROOT');
  }
  const all = [...srcList, ...extraRefs];
  const placed = all.map((p, i) => {
    const src = resolve(p);
    if (!existsSync(src)) throw new Error(`图不存在：${src}`);
    // 名字不含时间戳：同一张源图永远得到同一个文件名，LoadImage 的值不变，
    // ComfyUI 才会命中缓存 —— 否则每次重跑都从头算 15 分钟。
    const name = `sb${i}-${basename(src).replace(/[^\w.\-]/g, '_')}`;
    const dst = join(comfyInput, name);
    if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) copyFileSync(src, dst);
    return name;
  });

  const tplPath = resolve('workflows/h3-multiref-user-2pass.api.json');
  const g = JSON.parse(readFileSync(tplPath, 'utf8'));
  const refEntry = Object.entries(g).find(([, n]) => n.class_type === 'MiniMaxH3ReferenceToVideo');
  if (!refEntry) throw new Error('模板里没有 MiniMaxH3ReferenceToVideo');
  g[refEntry[0]].inputs.prompt = videoPrompt();

  // 第 0 个（分镜图）替换原有 ref_image_0 的上游 LoadImage；其余追加新的 LoadImage 节点
  const link = g[refEntry[0]].inputs['ref_images.ref_image_0'];
  if (!link) throw new Error('模板里没有 ref_images.ref_image_0');
  const upId = String(link[0]);
  if (!g[upId] || g[upId].class_type !== 'LoadImage') throw new Error('ref_image_0 上游不是 LoadImage');
  g[upId].inputs.image = placed[0];

  // 追加三视图：一律新建 LoadImage 节点（复用会命中同一个节点，导致两个槽位指向同一张图）
  let nextId = Math.max(...Object.keys(g).map((x) => Number(x)), 0);
  for (let i = 1; i < placed.length; i++) {
    nextId += 1;
    const id = String(nextId);
    g[id] = { class_type: 'LoadImage', inputs: { image: placed[i], upload: 'image' }, _meta: { title: `参考${i}` } };
    g[refEntry[0]].inputs[`ref_images.ref_image_${i}`] = [id, 0];
  }

  const noise = Object.entries(g).find(([, n]) => n.class_type === 'RandomNoise');
  if (noise) noise[1].inputs.noise_seed = seed;
  for (const [, n] of Object.entries(g)) {
    if (n.class_type === 'VHS_VideoCombine') n.inputs.filename_prefix = 'video/storyboard/sb';
  }
  const runPath = join(outDir, 'h3-run.api.json');
  writeFileSync(runPath, JSON.stringify(g, null, 1), 'utf8');
  return { names: placed, runPath, comfyInput };
}

// ---------------------------------------------------------------- 提交
// 网关端口不能硬编码：DSH 重启后 GUI 端口会变（实测 63197 → 58874），写死会静默退回直连，
// 表现为"面板里看不到、工作流不落 ComfyUI"——这种静默降级比报错更难查。
// 探测顺序：DSH_WEB 环境变量 > 常见端口 > 直连 /prompt。
async function findGateway() {
  const cands = [
    process.env.DSH_WEB,
    ...(process.env.DSH_WEB_PORTS || '').split(',').filter(Boolean).map((p) => `http://127.0.0.1:${p.trim()}`),
    'http://127.0.0.1:58874',
    'http://127.0.0.1:63197',
  ].filter(Boolean);
  for (const base of cands) {
    try {
      const r = await fetch(`${base}/comfy-live/api/state`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return base;
    } catch { /* 下一个 */ }
  }
  return null;
}

let _gw;
async function submit(graph) {
  const payload = { workflow: graph, extra_data: { comfy_usage_source: 'dsh-storyboard' } };
  if (_gw === undefined) _gw = await findGateway();
  if (_gw) {
    try {
      const r = await fetch(`${_gw}/comfy-live/api/submit`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (r.ok && (j.prompt_id || j.id)) return { via: `gateway(${_gw})`, id: j.prompt_id || j.id };
    } catch { /* 退回直连 */ }
  }
  console.error('  ⚠ 没找到实时台网关，退回直连 /prompt（面板看不到这次执行，工作流也不会写进 ComfyUI）');
  const r = await fetch(`${BASE}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`提交失败 ${r.status}: ${JSON.stringify(j).slice(0, 500)}`);
  return { via: 'direct', id: j.prompt_id };
}

async function waitOne(id, maxMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const e = await (await fetch(`${BASE}/history/${id}`)).json();
    const rec = e[id];
    if (rec && ['success', 'error'].includes(rec.status?.status_str)) return rec;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`等超时：${id}`);
}

// ---------------------------------------------------------------- 模板
const tpl = JSON.parse(readFileSync(resolve('workflows/illustrious_t2i.json'), 'utf8'));
function buildGraph({ prompt, negative, seed: sd, prefix }) {
  const g = JSON.parse(JSON.stringify(tpl.workflow));
  const set = (bind, val) => {
    const [id, key] = tpl.bindings[bind];
    g[id].inputs[key] = val;
  };
  set('prompt', prompt);
  set('negative', negative || NEG_STORYBOARD);
  set('width', width);
  set('height', height);
  set('steps', steps);
  set('cfg', 6);
  set('seed', sd);
  set('filename_prefix', prefix);
  return g;
}

// ---------------------------------------------------------------- 主流程
const outDir = resolve(outBase);
mkdirSync(outDir, { recursive: true });

const imgPrompt = imagePrompt();
const vidPrompt = videoPrompt();
writeFileSync(join(outDir, 'image-prompt.txt'), imgPrompt, 'utf8');
writeFileSync(join(outDir, 'video-prompt.txt'), vidPrompt, 'utf8');
writeFileSync(
  join(outDir, 'shots.json'),
  JSON.stringify({ seed, width, height, panels: shots.length, shots }, null, 2),
  'utf8'
);

console.log(`镜头 ${shots.length} 条 · 画布 ${width}x${height} · seed ${seed} · 候选 ${candidates}`);
console.log(`图像提示词 ${imgPrompt.length} 字符 → image-prompt.txt`);
console.log(`视频提示词 ${vidPrompt.length} 字符 → video-prompt.txt`);

// ---------- 接回云端出的图 → 直接生成可跑的 H3 运行图 ----------
const importPath = arg('import', null);
if (importPath) {
  const r = importImage([importPath], argAll('ref'));
  console.log(`\n已登记参考图 ${r.names.length} 张：${r.names.join(', ')}`);
  console.log(`配对运行图：${r.runPath}`);
  if (has('run')) {
    const g = JSON.parse(readFileSync(r.runPath, 'utf8'));
    const { via, id } = await submit(g);
    console.log(`已提交 ${id}（via ${via}），等它跑完…`);
    const rec = await waitOne(id, 40 * 60 * 1000);
    const outs = [];
    for (const no of Object.values(rec.outputs || {})) {
      for (const [k2, v] of Object.entries(no || {})) {
        if ((k2 === 'gifs' || k2 === 'videos') && Array.isArray(v)) {
          for (const it of v) outs.push(`${it.subfolder ? it.subfolder + '/' : ''}${it.filename}`);
        }
      }
    }
    console.log(`状态 ${rec.status?.status_str}`);
    console.log('产物：\n  ' + outs.join('\n  '));
  } else {
    console.log(`直接跑：POST /prompt 提交它，或加 --run 让它自己跑`);
  }
  process.exit(0);
}

// ---------- 默认：输出可直接粘给云端大模型的分镜提示词 ----------
if (!has('local')) {
  const cloud = buildCloudPrompt();
  const p = join(outDir, 'cloud-prompt.md');
  writeFileSync(p, cloud, 'utf8');
  console.log(`\n=== 分镜参考图提示词（直接粘给 GPT / 豆包 之类） → ${p} ===\n`);
  console.log(cloud);
  console.log(`\n拿到图后：node tools/storyboard.mjs --import <图路径> --shots ... --char ... --out ${outBase}`);
  console.log(`本地生成（能出版式、控不住内容）：加 --local`);
  process.exit(0);
}

if (dry) {
  console.log('\n--- 图像提示词 ---\n' + imgPrompt);
  console.log('\n--- 视频提示词（前 600 字） ---\n' + vidPrompt.slice(0, 600) + '…');
  process.exit(0);
}

const made = [];
for (let k = 0; k < candidates; k++) {
  const sd = seed + k;
  const prefix = `comfyforge/storyboard/sb_${seed}_k${k}`;
  const g = buildGraph({ prompt: imgPrompt, seed: sd, prefix });
  const { via, id } = await submit(g);
  console.log(`[${k + 1}/${candidates}] 提交 ${id}（via ${via}） seed ${sd}`);
  const rec = await waitOne(id);
  if (rec.status?.status_str !== 'success') {
    console.error(`  失败：${JSON.stringify(rec.status?.messages || []).slice(0, 300)}`);
    continue;
  }
  for (const no of Object.values(rec.outputs || {})) {
    for (const [k2, v] of Object.entries(no || {})) {
      if (k2 !== 'images' || !Array.isArray(v)) continue;
      for (const it of v) made.push({ seed: sd, file: `${it.subfolder ? it.subfolder + '/' : ''}${it.filename}` });
    }
  }
  console.log(`  完成 ${made.length ? made[made.length - 1].file : '(无产物)'}`);
}

writeFileSync(join(outDir, 'candidates.json'), JSON.stringify(made, null, 2), 'utf8');
console.log(`\n产物 ${made.length} 张，清单 candidates.json`);
console.log(`分镜图用它当 <Picture 1>：<ComfyUI>/output/${made[0]?.file || ''}`);
console.log(`配对提示词：${join(outDir, 'video-prompt.txt')}`);
