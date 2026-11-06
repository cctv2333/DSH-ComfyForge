// tools/frame-ab.mjs — 一采 / 二采 对照：同一时间点抽帧、裁同一块区域、并排拼起来
//
// 为什么要有它：2026-11-06 用户发现"最后一镜她张嘴但没有声音"。
// 查下来既不是抽卡也不是拼接丢音，而是**二采把嘴重新画了一遍，音频沿用一采没变**：
//   一采 13.2s / 14.6s 嘴闭（符合提示词 "lips stay closed"）
//   二采 同两点 嘴张
//   两边的音频 astats 与静音段逐位相同。
// 根因是二采只重采样视频 latent、音频 latent 原样拼回 —— 音画不再联合建模。
// 这类偏差肉眼看要半分钟，所以做成工具：10 秒出对照图 + 一个可比的数字（PSNR）。
//
// 用法：
//   node tools/frame-ab.mjs --a <一采.mp4> --b <二采.mp4> --at 13.2,14.6
//   node tools/frame-ab.mjs --a A --b B --at 13.2 --crop 0.25,0.08,0.5,0.47   # 归一化 x,y,w,h
//   node tools/frame-ab.mjs --a A --b B --at 13.2 --out .cache/qa/ab
//
// 判读：PSNR 越低 = 两个版本的这一块差得越多。嘴型漂了就会明显掉下来。
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../mcp/lib/config.mjs';
import { ffmpegBin } from '../mcp/lib/video.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

const A = arg('a');
const B = arg('b');
const AT = (arg('at', '') || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
// 默认裁「画面中上部」：脸部通常在那一块。四元组是归一化坐标 → 两个分辨率不同的视频也能对齐
const CROP = (arg('crop', '0.22,0.06,0.56,0.55') || '').split(',').map(Number);
const OUT = resolve(arg('out', join(PROJECT_ROOT, '.cache', 'qa', 'ab')));
// 两个输入分辨率不同（608×352 vs 1216×704），缩放后高度会有 1–2 px 的取整差异，
// hstack 会直接报 "Input 1 height 348 does not match input 0 height 346"。
// 所以不靠 -2 自动取整，而是**显式钉死输出尺寸**再 pad，保证两边完全一致。
const [OW, OH] = (arg('size', '640x360') || '640x360').split('x').map(Number);

if (!A || !B || !existsSync(A) || !existsSync(B)) {
  console.error('需要 --a <一采.mp4> 与 --b <二采.mp4>，且文件存在');
  process.exit(2);
}
if (!AT.length) { console.error('需要 --at 13.2,14.6（秒，逗号分隔）'); process.exit(2); }
if (CROP.length !== 4 || CROP.some((n) => !Number.isFinite(n))) {
  console.error('--crop 要四个数：x,y,w,h（归一化 0–1）');
  process.exit(2);
}

const ff = ffmpegBin();
const [x, y, w, h] = CROP;
mkdirSync(OUT, { recursive: true });

/** 裁同一块归一化区域、缩到同一尺寸、并排 —— 两个输入各自按自己的分辨率算 */
function framesAt(seconds, dest) {
  const crop = `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y}`;
  const fit = `scale=${OW}:${OH}:force_original_aspect_ratio=decrease,pad=${OW}:${OH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=rgb24`;
  const graph = [
    `[0:v]${crop},${fit}[a]`,
    `[1:v]${crop},${fit}[b]`,
    '[a][b]hstack=inputs=2[out]',
  ].join(';');
  execFileSync(ff, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(seconds), '-i', A,
    '-ss', String(seconds), '-i', B,
    '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-y', dest,
  ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
}

/** 同一块的 PSNR：越低说明差异越大。作为"改了多少"的可比数字 */
function psnrAt(seconds) {
  const crop = `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y}`;
  const fit = `scale=${OW}:${OH}:force_original_aspect_ratio=decrease,pad=${OW}:${OH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=rgb24`;
  const graph = [
    `[0:v]${crop},${fit}[a]`,
    `[1:v]${crop},${fit}[b]`,
    '[a][b]psnr[out]',
  ].join(';');
  // PSNR 是 filter 打在 stderr 上的统计行；execFileSync 成功时只回 stdout，
  // 所以这里必须用 spawnSync 才能把 stderr 拿回来（踩过：PSNR 全是 ?）
  try {
    const r = spawnSync(ff, [
      '-hide_banner', '-loglevel', 'info',
      '-ss', String(seconds), '-i', A,
      '-ss', String(seconds), '-i', B,
      '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-f', 'null', '-',
    ], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
    const text = `${r.stderr || ''}\n${r.stdout || ''}`;
    const m = /average:([\d.]+|inf)/i.exec(text);
    if (m) return m[1].toLowerCase() === 'inf' ? Infinity : Number(m[1]);
  } catch { /* 落到下面的 null */ }
  return null;
}

const rows = [];
for (const t of AT) {
  const dest = join(OUT, `ab_t${t}.png`);
  try {
    framesAt(t, dest);
    const psnr = psnrAt(t);
    rows.push({ t, dest, psnr });
  } catch (e) {
    rows.push({ t, dest: null, psnr: null, error: String(e?.message || e).slice(0, 120) });
  }
}

console.log(`一采 ${A}`);
console.log(`二采 ${B}`);
console.log(`裁同一块（归一化 x=${x} y=${y} w=${w} h=${h}），统一到 ${OW}×${OH} 并排\n`);
for (const r of rows) {
  if (!r.dest) { console.log(`  ${String(r.t).padStart(6)}s  ✗ ${r.error}`); continue; }
  const ps = r.psnr === null ? '?' : r.psnr === Infinity ? '相同' : r.psnr.toFixed(2) + ' dB';
  console.log(`  ${String(r.t).padStart(6)}s  PSNR ${ps.padEnd(10)}  ${r.dest}`);
}
const num = rows.map((r) => r.psnr).filter((n) => Number.isFinite(n));
if (num.length) {
  const mean = num.reduce((a, b) => a + b, 0) / num.length;
  console.log(`\n平均 PSNR ${mean.toFixed(2)} dB —— 越低说明二采改得越多。`);
  console.log('嘴型漂掉的时候，这个数会明显掉下来；把它记在每次二采的记录里就能做趋势。');
}
console.log(`\n对照图在 ${OUT}`);
