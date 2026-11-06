// h3.mjs — H3 出片的**唯一入口**，替代之前散落的 run_h3.py / vid.mjs / h3-film.mjs。
//
// 用法:
//   node tools/h3.mjs single <cfg.json>    一条片子（i2v 单遍）
//   node tools/h3.mjs 2pass  <cfg.json>    一条片子（r2v 一采 → 3D 放大 → 分块二采）
//   node tools/h3.mjs film   <cfg.json>    多镜头：末帧接首帧 + 自动拼接（i2v）
//
// 与旧脚本的差别（都是那天踩过的坑）：
//   * 每镜有硬超时，超时立刻报错退出，不再"永远等下去"
//   * 进度按"节点阶段 + 已用时间"打印，不再只有 ...
//   * 音频随视频一起出（H3 原生音轨），失败自动降级为无声
//   * 输出统一写 runs/，参数和产物对得上
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { startVideo, videoStatus, framesFor, ffmpegBin, videoMetrics } from '../mcp/lib/video.mjs';
import { COMFY_ROOT, PROJECT_ROOT, RUNS_DIR } from '../mcp/lib/comfy.mjs';

const [, , modeArg, cfgPath] = process.argv;
const mode = modeArg || 'single';
if (!cfgPath) {
  console.error('usage: node tools/h3.mjs <single|2pass|film> <cfg.json>');
  process.exit(2);
}
// 兼容 Windows 编辑器/PowerShell 常带的 UTF-8 BOM：JSON.parse 不认 BOM，会报
// "Unexpected token '﻿'" —— 这类错误看起来像配置写错，实际只是文件头多了三个字节。
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
const is2pass = mode === '2pass';
// 2pass 的一采分辨率要低（低清抽卡），单遍/多镜沿用高清
const W = cfg.width ?? (is2pass ? 608 : 1216);
const H = cfg.height ?? (is2pass ? 352 : 704);
const STEPS = cfg.steps ?? (is2pass ? 12 : 8);
const splitStep = cfg.splitStep ?? 8;
const scale = cfg.scale ?? 2;
const seed0 = cfg.seed ?? 2000;
const shotTimeoutS = cfg.shotTimeoutS ?? 1500; // 单镜硬超时（默认 25 分钟）
const inputDir = path.join(COMFY_ROOT, 'input');

const t0 = Date.now();
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logLines = [];
const log = (s) => { const line = `[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`; console.log(line); logLines.push(line); };

function lastFrame(mp4, name) {
  const out = path.join(inputDir, name);
  spawnSync(ffmpegBin(), ['-y', '-sseof', '-0.2', '-i', mp4, '-frames:v', '1', '-update', '1', out], { timeout: 60000 });
  if (!fs.existsSync(out)) throw new Error(`取末帧失败: ${mp4}`);
  return name;
}

async function runShot(i, shot, firstImage) {
  const seconds = shot.seconds ?? 5;
  const { frames } = framesFor(seconds);
  const started = await startVideo({
    mode: is2pass ? '2pass' : 'single',
    image: firstImage,
    prompt: shot.prompt,
    audio: shot.audio !== false,
    width: W, height: H, seconds, steps: STEPS,
    splitStep, scale,
    chunk: cfg.chunk ?? 153, overlap: cfg.overlap ?? 17,
    upscalerPrecision: cfg.upscalerPrecision ?? 'fp16',
    seed: seed0 + i,
    prefix: `music/${cfg.name || 'h3'}_s${i + 1}`,
  });
  const est = is2pass
    ? `${started.params.chunkCount} 块，二采 ${W * scale}x${H * scale}`
    : `预计 ${(frames * 4.6 / 60).toFixed(0)} 分钟`;
  log(`shot${i + 1} queued ${started.promptId} | ${mode} | ${frames} 帧 / ${(frames / 24).toFixed(1)}s | ${est}`);

  const deadline = Date.now() + shotTimeoutS * 1000;
  let lastLog = 0;
  for (;;) {
    const st = await videoStatus(started.promptId, { waitS: 45 });
    if (!st.pending) {
      if (st.errors?.length) throw new Error(`shot${i + 1} 执行错误: ${JSON.stringify(st.errors[0]).slice(0, 300)}`);
      const f = st.files?.[0];
      if (!f) throw new Error(`shot${i + 1} 无产物`);
      log(`shot${i + 1} done ${f.filename} (${f.metadata?.duration ?? '?'}s)`);
      return f.localPath || f.fullpath;
    }
    if (Date.now() > deadline) throw new Error(`shot${i + 1} 超时（${shotTimeoutS}s）——大概率卡在最后一步，已放弃`);
    const el = Math.round(st.elapsedMs / 1000);
    if (el - lastLog >= 60) { log(`shot${i + 1} ... ${el}s / 上限 ${shotTimeoutS}s`); lastLog = el; }
  }
}

const shots = mode === 'film'
  ? (cfg.shots || []).map((s) => ({ ...s, audio: s.audio ?? cfg.audio }))
  : [{ prompt: cfg.prompt, seconds: cfg.seconds, audio: cfg.audio }];
if (!shots.length) throw new Error('没有镜头');

const clips = [];
let chain = cfg.image;
for (let i = 0; i < shots.length; i++) {
  const file = await runShot(i, shots[i], chain);
  clips.push(file);
  if (i < shots.length - 1) chain = lastFrame(file, `${cfg.name || 'h3'}_chain${i + 1}.png`);
}

let final = clips[0];
if (clips.length > 1) {
  final = cfg.out || path.join(PROJECT_ROOT, 'out', `${cfg.name || 'h3'}_${stamp}.mp4`);
  fs.mkdirSync(path.dirname(final), { recursive: true });
  const args = ['-y'];
  for (const c of clips) args.push('-i', c);
  // 带音频拼接：每镜都有 H3 原生音轨，v=1:a=1 一次拼完，别再丢掉声音
  const filt = `${clips.map((_, i) => `[${i}:v][${i}:a]`).join('')}concat=n=${clips.length}:v=1:a=1[v][a]`;
  args.push('-filter_complex', filt, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', '24',
    '-c:a', 'aac', '-b:a', '192k', final);
  const r = spawnSync(ffmpegBin(), args, { encoding: 'utf8', timeout: 600000 });
  if (!fs.existsSync(final)) throw new Error(`拼接失败: ${(r.stderr || '').slice(-300)}`);
}

const total = ((Date.now() - t0) / 1000).toFixed(0);
log(`完成：${final} | 总用时 ${total}s | ${clips.length} 镜`);

// 落一份运行记录，和图片那套一致
try {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  let metrics = null;
  try { metrics = videoMetrics(final); } catch { /* 指标失败不影响记录 */ }
  const md = [
    `# H3 ${mode} · ${cfg.name || ''}`,
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 模式：${mode}${is2pass
      ? ((cfg.refineSteps != null || cfg.refineDenoise != null)
        ? `（一采 ${W}x${H} 跑满 ${STEPS} 步 → 3D 放大 ×${scale} = ${W * scale}x${H * scale} → 独立短曲线精修 ${cfg.refineSteps ?? 4} 步 denoise ${cfg.refineDenoise ?? 0.35}，块 ${cfg.chunk ?? 153}/${cfg.overlap ?? 17}。⚠ 这条路会重新加噪，音频会被一起重采样成谐波）`
        : `（一采 ${W}x${H} ${STEPS} 步拆 ${splitStep} → σ 连续下降 → ×${scale} = ${W * scale}x${H * scale}，后 ${STEPS - splitStep} 步接同一条曲线，块 ${cfg.chunk ?? 153}/${cfg.overlap ?? 17}）`)
      : ''}`,
    `- 分辨率：${W}x${H}，步数：${STEPS}，seed：${seed0}`,
    metrics ? `- 指标：时长 ${metrics.duration}s / 帧间差分 ${metrics.flicker}（p95 ${metrics.flickerP95}）/ 黑帧段 ${metrics.blackRuns} / 切点 ${metrics.cuts} / 音量 ${metrics.loudnessDb ?? '无'}dB` : null,
    `- 总用时：${total}s，镜数：${clips.length}`,
    `- 成片：\`${final}\``,
    '',
    '## 镜头',
    ...shots.map((s, i) => `${i + 1}. (${s.seconds ?? 5}s) ${s.prompt}`),
  ].filter((l) => l !== null).join('\n');
  fs.writeFileSync(path.join(RUNS_DIR, `h3-${stamp}.md`), md, 'utf8');
} catch { /* 记录失败不影响成片 */ }
