#!/usr/bin/env node
// tools/shots.mjs —— 自动分镜：把一个视频按「画面真切点」切成镜头，并出镜头表 + 联络图
//
// 为什么需要它：
//   分镜有两件事常被混在一起 —— ①生成时在提示词里写 [Shot] 时间码（模型自己切）；
//   ②拿到成片后要能验证「切在不在该切的地方」，并把每条镜头拆出来单独看/单独重跑。
//   这个工具做的是 ②。它只看画面，不看提示词，所以对「别人给的工作流」和「自己跑的」一样有效。
//
// 用法：
//   node tools/shots.mjs <video>                     只报告，不落盘
//   node tools/shots.mjs <video> --out .cache/shots   切出每个镜头 + 联络图
//   node tools/shots.mjs <video> --min 1.0 --thr 0.35
//
// 判定依据（都是 ffmpeg 原语，不引依赖）：
//   · scene 分数 > thr 的位置是「切点」；
//   · 间隔小于 --min 的连续切点合并成一个（变身/爆闪那种 0.1 秒内连切 4 刀，是一个镜头内的高频变化）；
//   · 每个镜头的首帧拼成联络图，肉眼一眼看出「镜头是不是真的换了」。

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { ffmpegBin, probeDuration, videoMetrics } from '../mcp/lib/video.mjs';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}
const flag = (name) => process.argv.includes(`--${name}`);

/** 用 ffmpeg 的 scene 过滤器取切点时间（秒） */
function sceneCuts(videoPath, thr) {
  const r = spawnSync(
    ffmpegBin(),
    ['-hide_banner', '-i', videoPath, '-an', '-vf', `select='gt(scene,${thr})',metadata=print:file=-`, '-f', 'null', '-'],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 }
  );
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  const out = [];
  for (const m of text.matchAll(/pts_time:([0-9.]+)/g)) out.push(Number(m[1]));
  return [...new Set(out)].sort((a, b) => a - b);
}

/** 间隔太近的切点合并：只留每簇的第一个 */
function mergeCuts(cuts, minGap) {
  const kept = [];
  for (const t of cuts) {
    if (!kept.length || t - kept[kept.length - 1] >= minGap) kept.push(t);
  }
  return kept;
}

/** 由切点得到镜头区间 */
function shotsFrom(cuts, duration, minShot) {
  const bounds = [0, ...cuts.filter((t) => t > minShot && t < duration - minShot), duration];
  const shots = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (end - start < minShot * 0.5) continue;
    shots.push({ index: shots.length + 1, start, end, duration: end - start });
  }
  return shots;
}

const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;

async function main() {
  const video = process.argv[2];
  if (!video) {
    console.error('用法: node tools/shots.mjs <video> [--out 目录] [--thr 0.3] [--min 0.8]');
    process.exit(1);
  }
  const path = resolve(video);
  const thr = Number(arg('thr', '0.3'));
  const minShot = Number(arg('min', '0.8'));
  const outDirArg = arg('out', null);

  const duration = probeDuration(path);
  if (!duration) {
    console.error(`读不出时长：${path}`);
    process.exit(2);
  }

  const raw = sceneCuts(path, thr);
  const cuts = mergeCuts(raw, minShot);
  const shots = shotsFrom(cuts, duration, minShot);

  const m = videoMetrics(path);
  console.log(`\n视频  ${basename(path)}`);
  console.log(`      ${m.width}x${m.height} · ${m.fps}fps · ${duration.toFixed(2)}s · flicker ${m.flicker} · 音轨 ${m.hasAudio ? '有' : '无'}`);
  console.log(`原始切点 ${raw.length} 个 → 合并后 ${cuts.length} 个（间隔 < ${minShot}s 视为同一镜头内的变化）`);
  console.log(`\n镜头表（共 ${shots.length} 个）`);
  console.log('  #   起点      终点      时长');
  for (const s of shots) {
    console.log(`  ${String(s.index).padStart(2)}  ${fmt(s.start)}  ${fmt(s.end)}  ${s.duration.toFixed(2)}s`);
  }

  if (outDirArg) {
    const outDir = resolve(outDirArg);
    mkdirSync(outDir, { recursive: true });
    const made = [];
    for (const s of shots) {
      const out = join(outDir, `shot${String(s.index).padStart(2, '0')}.mp4`);
      const r = spawnSync(
        ffmpegBin(),
        ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(s.start), '-to', String(s.end), '-i', path,
          '-c:v', 'libx264', '-crf', '16', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '192k', out],
        { encoding: 'utf8', timeout: 180000 }
      );
      if (r.status === 0) made.push(out);
      else console.error(`  切第 ${s.index} 条失败: ${(r.stderr || '').split('\n').slice(-2).join(' ')}`);
    }
    // 联络图：每个镜头取中点一帧，一行排开
    const sheet = join(outDir, '_shots-sheet.png');
    const cols = Math.min(shots.length, 6);
    const mid = shots.map((s) => s.start + s.duration / 2);
    const expr = mid
      .map((t) => `eq(n\\,${Math.round(t * m.fps)})`)
      .join('+');
    const r2 = spawnSync(
      ffmpegBin(),
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', path,
        '-vf', `select='${expr}',scale=360:-1,tile=${cols}x${Math.ceil(shots.length / cols)}`,
        '-frames:v', '1', '-vsync', '0', sheet],
      { encoding: 'utf8', timeout: 120000 }
    );
    if (r2.status === 0) made.push(sheet);

    const report = {
      video: path, duration, width: m.width, height: m.height, fps: m.fps,
      rawCuts: raw, mergedCuts: cuts, shots,
      threshold: thr, minShot, made,
    };
    const jsonPath = join(outDir, 'shots.json');
    writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    made.push(jsonPath);

    console.log(`\n落到 ${outDir}`);
    for (const f of made) console.log(`  ${basename(f)}`);
    if (made.length > 1) console.log(`\n联络图：${sheet}`);
  }

  console.log(`\n判读提示`);
  const short = shots.filter((s) => s.duration < 1.0);
  if (short.length) console.log(`  · ${short.length} 个镜头短于 1 秒 —— 要确认是「有意的快切」还是「画面在崩」`);
  if (shots.length === 1) console.log(`  · 全程只有 1 个镜头：没有镜头切换。想要分镜，得在提示词里写 [Shot] 时间码，而不是靠后期剪`);
  if (m.cuts > shots.length) console.log(`  · metrics 报 ${m.cuts} 个切点、这里合并成 ${shots.length} 个：差出来的就是镜头内的高频变化`);
  console.log('');
}

main();
