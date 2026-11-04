#!/usr/bin/env node
// music-video.mjs — 把一条短循环片段铺满整首音乐
//
// 用法:
//   node tools/music-video.mjs <片段.mp4> <音乐.m4a> <输出.mp4> [选项]
//     --duration=183     目标时长（默认 0 = 跟音乐一样长）
//     --mode=palindrome  正放+倒放（数学上必然无缝，默认）
//            loop       纯循环（接缝靠素材自己闭合，容易跳）
//     --fade=2.5         结尾淡出秒数（默认 2.5）
//     --xfade=0          接缝交叉淡化秒数（palindrome 模式不需要，loop 模式建议 0.3–0.5）
//
// 为什么默认 palindrom：实测 H3 的 last_frame 条件并不能真的把末帧拉回首帧
// （39 帧探针 PSNR 只有 21.4 dB），硬循环会在接缝处跳一下。正放+倒放没有接缝——
// 运动方向翻转，对呼吸/眨眼/点头这类慢动作几乎看不出来。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ffmpegBin, probeDuration, videoMetrics } from '../mcp/lib/video.mjs';

const [, , clip, music, out, ...rest] = process.argv;
if (!clip || !music || !out) {
  console.error('usage: node tools/music-video.mjs <片段.mp4> <音乐.m4a> <输出.mp4> [--duration=183] [--mode=palindrome|loop] [--fade=2.5] [--xfade=0]');
  process.exit(2);
}
const opt = (n, d) => {
  const a = rest.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};
const mode = opt('mode', 'palindrome');
const fade = +opt('fade', 2.5);
const xfade = +opt('xfade', 0);
const bin = ffmpegBin();

for (const f of [clip, music]) if (!existsSync(f)) { console.error(`文件不存在：${f}`); process.exit(2); }

const clipDur = probeDuration(clip);
const musicDur = probeDuration(music);
if (!clipDur || !musicDur) { console.error('读不到时长'); process.exit(2); }
const target = +opt('duration', 0) || musicDur;
console.log(`片段 ${clipDur.toFixed(3)}s · 音乐 ${musicDur.toFixed(3)}s · 目标 ${target.toFixed(2)}s · 模式 ${mode}`);

const tmp = mkdtempSync(join(tmpdir(), 'mvloop-'));
const run = (args, label) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`${label} 失败：\n${String(r.stderr).split('\n').slice(-8).join('\n')}`);
    process.exit(1);
  }
};

// 1) 造一个"本身无缝"的循环单元
const unit = join(tmp, 'unit.mp4');
if (mode === 'palindrome') {
  run(['-y', '-i', clip,
    '-filter_complex', '[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-an', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p', unit], '造倒放单元');
} else if (xfade > 0) {
  // 把尾部和头部叠化：先取尾 xfade 秒、头 xfade 秒做 blend，再拼
  const body = Math.max(0.1, clipDur - xfade);
  run(['-y', '-i', clip, '-filter_complex',
    `[0:v]trim=0:${body},setpts=PTS-STARTPTS[main];` +
    `[0:v]trim=start=${body},setpts=PTS-STARTPTS[tail];` +
    `[0:v]trim=0:${xfade},setpts=PTS-STARTPTS[head];` +
    `[tail][head]blend=all_expr='A*(1-T/${xfade})+B*(T/${xfade})'[bl];` +
    `[main][bl]concat=n=2:v=1:a=0[v]`,
    '-map', '[v]', '-an', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p', unit], '造交叉淡化单元');
} else {
  run(['-y', '-i', clip, '-an', '-c:v', 'copy', unit], '复制单元');
}
const unitDur = probeDuration(unit);
console.log(`循环单元 ${unitDur.toFixed(3)}s · 需要重复 ${Math.ceil(target / unitDur)} 次`);

// 2) 循环铺满 + 混音 + 结尾淡出
const fadeStart = Math.max(0, target - fade);
run(['-y',
  '-stream_loop', '-1', '-i', unit,
  '-i', music,
  '-filter_complex',
  `[0:v]trim=0:${target},setpts=PTS-STARTPTS,${fade > 0 ? `fade=t=out:st=${fadeStart}:d=${fade}` : 'null'}[v];` +
  `[1:a]volume=-1.5dB,${fade > 0 ? `afade=t=out:st=${fadeStart}:d=${fade}` : 'anull'}[a]`,
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', '24',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-t', String(target), out], '合成');

rmSync(tmp, { recursive: true, force: true });

const m = videoMetrics(out);
console.log(`\n输出 ${out}`);
console.log(`时长 ${m.duration}s · ${m.width}x${m.height} · ${m.fps}fps · 音轨 ${m.hasAudio ? '有' : '无'} · 音量 ${m.loudnessDb ?? '-'}dB`);
console.log(`帧间差分 ${m.flicker}（p95 ${m.flickerP95}）· 黑帧段 ${m.blackRuns} · 强切点 ${m.cuts}`);
console.log(m.cuts > 1 ? '⚠️ 检测到多个强切点：如果这些不是设计好的，说明循环接缝在跳' : '接缝干净');
