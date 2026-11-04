// review-videos.mjs — 一次看完一批视频：指标表 + 每条的抽帧联络表
//
// 用法: node tools/review-videos.mjs <视频1> <视频2> ... [--times=1,2.5,4] [--out=.cache/review.png]
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';

import { videoMetrics, extractFrames, ffmpegBin } from '../mcp/lib/video.mjs';
import { PROJECT_ROOT } from '../mcp/lib/comfy.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};
const files = args.filter((a) => !a.startsWith('--'));
const times = opt('times', '1,2.5,4').split(',').map(Number);
const outImg = opt('out', join(PROJECT_ROOT, '.cache', 'review.png'));
if (!files.length) { console.error('用法: node tools/review-videos.mjs <视频...>'); process.exit(2); }

const rows = [];
for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`跳过（不存在）：${f}`); continue; }
  const m = videoMetrics(f);
  const frames = extractFrames(f, { times, width: 480 });
  rows.push({ file: f, m, frames });
  console.log(`${basename(f)}  ${m.duration}s ${m.width}x${m.height} 闪烁 ${m.flicker} 黑帧 ${m.blackRuns} 切点 ${m.cuts} 音量 ${m.loudnessDb ?? '-'}dB`);
}

// 每行一条视频，每列一个时间点
const cols = times.length;
const cellW = 480;
const cellH = Math.round(cellW * (rows[0]?.m.height ?? 704) / (rows[0]?.m.width ?? 1216));
const inputs = []; const chain = []; const layout = [];
let n = 0;
rows.forEach((r, ri) => {
  r.frames.forEach((fr, ci) => {
    inputs.push('-i', fr.path);
    chain.push(`[${n}:v]scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=black[v${n}]`);
    layout.push(`${ci * cellW}_${ri * cellH}`);
    n++;
  });
});
if (n) {
  const r = spawnSync(ffmpegBin(), ['-y', ...inputs, '-filter_complex', `${chain.join(';')};${[...Array(n).keys()].map((k) => `[v${k}]`).join('')}xstack=inputs=${n}:layout=${layout.join('|')}:fill=black`, '-frames:v', '1', outImg], { encoding: 'utf8' });
  console.log(fs.existsSync(outImg) ? `\n联络表（行=视频，列=${times.join('/')}s）：${outImg}` : `拼图失败 ${String(r.stderr).slice(-200)}`);
}

const avg = rows.length ? (rows.reduce((s, r) => s + (r.m.flicker || 0), 0) / rows.length).toFixed(2) : '-';
console.log(`\n平均帧间差分 ${avg}（越小越稳）· 共 ${rows.length} 条`);
