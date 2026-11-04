// lib/sweep.mjs — 低清抽卡：一批 seed 跑草片 → 客观指标排序 → 挑出来再精修
//
// 为什么这么做（而不是直接出高清）：
//   * 单遍高清 15s 要 30 分钟且会卡在最后一步；低清草片 1/4 成本，好坏当场能分。
//   * 肉眼挑低清不靠眉目——草片用小窗看不清，所以排序走客观指标（帧间差分/黑帧/切点/音量）。
//   * 只把前 K 条送二采，把预算花在"已经证明能跑"的那几条上。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { startVideo, videoStatus, framesFor, extractFrames, videoMetrics, ffmpegBin } from './video.mjs';
import { PROJECT_ROOT, RUNS_DIR } from './comfy.mjs';

/**
 * 跑一批种子（默认走"一采整条跑满"的低清草片，不是半截 latent）。
 * @param {object} o
 * @param {string} o.image prompt seconds seeds
 * @param {number} [o.width=608] [o.height=352] [o.steps=8]
 * @param {(msg:string)=>void} [o.log]
 */
export async function runSweep(o) {
  const log = o.log || (() => {});
  const seeds = o.seeds ?? [];
  if (!seeds.length) throw new Error('sweep 需要至少一个 seed');
  const { frames } = framesFor(o.seconds ?? 5);
  const width = o.width ?? 608;
  const height = o.height ?? 352;
  const steps = o.steps ?? 8;

  const rows = [];
  for (const seed of seeds) {
    const t0 = Date.now();
    const started = await startVideo({
      mode: '2pass', pass1Only: true,   // 只跑一采，解出来就是完整画面（不是半截 latent）
      image: o.image, prompt: o.prompt,
      width, height, seconds: o.seconds ?? 5, steps, seed,
      splitStep: steps,                  // pass1Only 会覆盖 sigmas，这里只是占位
      prefix: o.prefix ?? `comfyforge/sweep/${o.tag ?? 'sweep'}`,
      audio: o.audio !== false,
    });
    log(`seed ${seed} 提交 ${started.promptId}（${frames} 帧 / ${width}x${height} / ${steps} 步）`);

    let st;
    const deadline = Date.now() + (o.timeoutS ?? 1800) * 1000;
    for (;;) {
      st = await videoStatus(started.promptId, { waitS: 45 });
      if (!st.pending) break;
      if (Date.now() > deadline) throw new Error(`seed ${seed} 超时`);
      log(`seed ${seed} … ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    const secs = +((Date.now() - t0) / 1000).toFixed(0);
    if (st.errors?.length) {
      rows.push({ seed, ok: false, error: JSON.stringify(st.errors[0]).slice(0, 200), elapsedS: secs });
      log(`seed ${seed} 失败：${JSON.stringify(st.errors[0]).slice(0, 120)}`);
      continue;
    }
    const file = st.files?.[0];
    if (!file?.localPath) {
      rows.push({ seed, ok: false, error: 'no_output', elapsedS: secs });
      continue;
    }
    const m = videoMetrics(file.localPath);
    rows.push({ seed, ok: true, path: file.localPath, elapsedS: secs, metrics: m });
    log(`seed ${seed} 完成 ${secs}s · 闪烁 ${m.flicker} · 黑帧 ${m.blackRuns} · 切点 ${m.cuts} · 音量 ${m.loudnessDb ?? '无'} · 分 ${m.score}`);
  }

  const ranked = [...rows].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return (a.metrics?.score ?? 999) - (b.metrics?.score ?? 999);
  });
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return { frames, width, height, steps, rows, ranked, best: ranked[0] };
}

/** 把每条草片的一帧拼成一张对照图（挑图用） */
export function buildSweepSheet(rows, { at = 0.8, outDir } = {}) {
  const ok = rows.filter((r) => r.ok && r.path);
  if (!ok.length) return { ok: false, error: '没有成功的草片' };
  const frames = [];
  for (const r of ok) {
    const [f] = extractFrames(r.path, { times: [at], width: 480, outDir });
    if (f) frames.push({ ...f, seed: r.seed, rank: r.rank });
  }
  if (frames.length < 2) return { ok: false, error: '少于 2 条，不用拼' };
  const cols = Math.min(3, frames.length);
  const out = join(outDir || join(PROJECT_ROOT, '.cache', 'sheets'), `sweep-${Date.now()}.png`);
  const inputs = frames.flatMap((f) => ['-i', f.path]);
  const scaled = frames.map((_, i) => `[${i}:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:color=black[v${i}]`).join(';');
  const layout = frames.map((_, i) => `${(i % cols) * 480}_${Math.floor(i / cols) * 270}`).join('|');
  const r = spawnSync(ffmpegBin(), [
    '-y', ...inputs,
    '-filter_complex', `${scaled};${frames.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${frames.length}:layout=${layout}:fill=black`,
    '-frames:v', '1', out,
  ], { encoding: 'utf8', timeout: 120000 });
  if (!existsSync(out)) return { ok: false, error: (r.stderr || '').split('\n').slice(-2).join(' ') };
  return { ok: true, path: out, count: frames.length, cells: frames.map((f) => ({ seed: f.seed, rank: f.rank })) };
}

/** 落一份 sweep 记录 */
export function writeSweepRecord(res, extra = {}) {
  mkdirSync(RUNS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const md = [
    `# H3 抽卡 · ${extra.name ?? ''}`,
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 草片参数：${res.width}x${res.height} / ${res.frames} 帧 / ${res.steps} 步（一采跑满，非半截 latent）`,
    `- 种子：${res.rows.map((r) => r.seed).join(', ')}`,
    '',
    '| 排名 | seed | 分 | 闪烁 | p95 | 黑帧 | 切点 | 音量 | 耗时 | 文件 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...res.ranked.map((r) => (r.ok
      ? `| ${r.rank} | ${r.seed} | ${r.metrics.score} | ${r.metrics.flicker} | ${r.metrics.flickerP95} | ${r.metrics.blackRuns} | ${r.metrics.cuts} | ${r.metrics.loudnessDb ?? '-'} | ${r.elapsedS}s | ${r.path.split(/[\\/]/).pop()} |`
      : `| ${r.rank} | ${r.seed} | 失败 | - | - | - | - | - | ${r.elapsedS}s | ${r.error} |`)),
    '',
    extra.sheet ? `对照图：\`${extra.sheet}\`` : null,
    extra.note ? `\n${extra.note}` : null,
  ].filter((l) => l !== null).join('\n');
  const p = join(RUNS_DIR, `sweep-${stamp}.md`);
  writeFileSync(p, md, 'utf8');
  return p;
}
