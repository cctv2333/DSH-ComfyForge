#!/usr/bin/env node
// preflight.mjs — "这台机器能做什么、差什么、差的东西多大、放哪"
//
// 用法:
//   node tools/preflight.mjs              看本机（有 ComfyUI 就跑全查）
//   node tools/preflight.mjs --empty      模拟"什么都没有的电脑"：看工具会不会说人话
//
// 三种环境都能出结论：
//   ① ComfyUI 在跑：查节点 + 查磁盘
//   ② ComfyUI 没跑但有 COMFY_ROOT：只查磁盘，节点那部分标"未知"
//   ③ 什么都没有：全部标"未知/缺"，并给最小安装清单
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { checkRequirements, summarize } from '../mcp/lib/requires.mjs';
import { COMFY_ROOT } from '../mcp/lib/comfy.mjs';
import { ffmpegBin } from '../mcp/lib/video.mjs';

const empty = process.argv.includes('--empty');
// 和真正干活的工具用同一套解析顺序：FFMPEG_PATH > 本机已知位置 > PATH。
// 只看 PATH 会把"能用"误判成"不能用"——这台机器就是这种情况。
const hasBin = (b) => {
  if (b === 'ffmpeg') {
    const resolved = ffmpegBin();
    if (resolved !== 'ffmpeg' && existsSync(resolved)) return true;
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  }
  return spawnSync(b, ['-version'], { stdio: 'ignore' }).status === 0;
};

let nodes = null;
let comfyRoot = COMFY_ROOT;
let comfyNote = '';
if (!empty) {
  try {
    const url = process.env.COMFY_URL || 'http://127.0.0.1:8188';
    const r = await fetch(`${url}/object_info`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) { nodes = new Set(Object.keys(await r.json())); comfyNote = `ComfyUI 已连上（${url}）`; }
    else comfyNote = `ComfyUI 返回 ${r.status}`;
  } catch {
    comfyNote = 'ComfyUI 没连上（不影响下面按磁盘判定的部分）';
  }
} else {
  comfyRoot = null;
  comfyNote = '模拟空机器：不查 ComfyUI、不查磁盘';
}

const rows = checkRequirements({ nodes, comfyRoot, hasBin });
const sum = summarize(rows);

const mark = (r) => (r.status === 'ok' ? '\x1b[32m[可用]\x1b[0m'
  : r.status === 'unknown' ? '\x1b[33m[未知]\x1b[0m' : '\x1b[31m[不可用]\x1b[0m');
console.log(`\n环境：${process.platform} · Node ${process.version} · ${comfyNote}`);
console.log(`COMFY_ROOT：${comfyRoot ?? '（未知）'}`);
console.log(`\n${sum.okCount}/${sum.total} 项确认可用${sum.unknownCount ? ` · ${sum.unknownCount} 项无法确认` : ''}\n`);

for (const r of rows) {
  console.log(`${mark(r)} ${r.title}`);
  console.log(`        ${r.what}`);
  if (r.ok && r.warns.length) for (const w of r.warns) console.log(`        · ${w.what}`);
  for (const m of r.missing) {
    console.log(`        ✗ 缺：${m.what}`);
    console.log(`          → ${m.how}`);
  }
  if (!r.ok && r.minimal) console.log(`        · 最低门槛：${r.minimal}`);
  if (!r.ok && r.degrade) console.log(`        · 降级方案：${r.degrade}`);
  if (r.optional) for (const o of r.optional) console.log(`        · 可选增强：${o.what} → ${o.need}`);
  console.log('');
}

if (sum.cannot.length) {
  console.log('— 这台机器做不了的 —');
  for (const c of sum.cannot) console.log(`  ${c.title}：缺 ${c.missing.join('、')}`);
  console.log('');
}

// 最小安装清单：只列"不可用"项里最基础的那层，避免让人一次下 80GB
const needComfy = rows.some((r) => !r.ok && r.id === 'image-sheet');
const needFfmpeg = rows.some((r) => !r.ok && r.missing.some((m) => m.kind === 'bin'));
console.log('— 从零开始的最小路径 —');
if (needComfy) console.log('  1) 装 ComfyUI（本体约 1–2GB，含 Python 环境）');
if (needFfmpeg) console.log(`  ${needComfy ? 2 : 1}) 装 ffmpeg 并放进 PATH（约 100MB）`);
console.log('  · 校验器（prompt-lint）和指标（metrics）不需要上面任何东西，只要 Node 就能跑。');
console.log('  · 视频那 51GB 权重是"要不要做视频"的选择题，不是必需品。\n');
