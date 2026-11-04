#!/usr/bin/env node
// sweep.mjs — 低清抽卡：一批 seed 出草片 → 指标排序 → 挑出来的再走二采
//
// 用法:
//   node tools/sweep.mjs <cfg.json>
//   cfg: { "image": "...", "prompt": "...", "seconds": 5,
//          "seeds": [11,22,33], "width": 608, "height": 352, "steps": 8,
//          "refineTop": 0 }        // refineTop>0 时把前 K 条送二采精修
//
// 与"直接出高清"的差别：草片是一采**跑满**的完整画面（不是半截 latent），
// 所以能肉眼看出构图/动作/手；成本约 1/4。
import fs from 'node:fs';

import { runSweep, buildSweepSheet, writeSweepRecord } from '../mcp/lib/sweep.mjs';
import { startVideo, videoStatus, videoMetrics } from '../mcp/lib/video.mjs';

const cfgPath = process.argv[2];
if (!cfgPath) {
  console.error('usage: node tools/sweep.mjs <cfg.json>');
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
const seeds = cfg.seeds ?? Array.from({ length: cfg.count ?? 4 }, (_, i) => (cfg.seed ?? 1000) + i * 7);
const tag = cfg.tag ?? cfg.name ?? 'sweep';

const log = (s) => console.log(`[sweep] ${s}`);

if (cfg.prompt) {
  const { lintPrompt } = await import('../mcp/lib/promptlint.mjs');
  const rep = lintPrompt(cfg.prompt, { seconds: cfg.seconds });
  if (rep.counts.errors) {
    console.error(`提示词有 ${rep.counts.errors} 个错误，先跑 node tools/prompt-lint.mjs：`);
    for (const i of rep.issues.filter((x) => x.level === 'error')) console.error(`  - ${i.msg}`);
    process.exit(1);
  }
  log(`提示词 ${rep.score}/100（${rep.counts.warnings} 警告），继续`);
}

const res = await runSweep({
  image: cfg.image, prompt: cfg.prompt, seconds: cfg.seconds ?? 5,
  seeds, width: cfg.width ?? 608, height: cfg.height ?? 352, steps: cfg.steps ?? 8,
  tag, log, timeoutS: cfg.timeoutS,
});

const sheet = buildSweepSheet(res.ranked);
log(sheet.ok ? `对照图 ${sheet.path}` : `对照图没拼成：${sheet.error}`);

// 可选：把前 K 条按二采精修（真正的高清）
let refined = [];
if (cfg.refineTop > 0) {
  for (const r of res.ranked.filter((x) => x.ok).slice(0, cfg.refineTop)) {
    log(`精修 seed ${r.seed} → ${(cfg.width ?? 608) * (cfg.scale ?? 2)}x${(cfg.height ?? 352) * (cfg.scale ?? 2)}`);
    const started = await startVideo({
      mode: '2pass',
      image: cfg.image, prompt: cfg.prompt, seconds: cfg.seconds ?? 5,
      width: cfg.width ?? 608, height: cfg.height ?? 352,
      steps: cfg.steps2 ?? 12, refineSteps: cfg.refineSteps ?? 4, refineDenoise: cfg.refineDenoise ?? 0.35,
      scale: cfg.scale ?? 2, seed: r.seed,
      prefix: `comfyforge/sweep/${tag}-refine`,
    });
    for (;;) {
      const st = await videoStatus(started.promptId, { waitS: 45 });
      if (st.pending) { log(`seed ${r.seed} 精修中 ${Math.round(st.elapsedMs / 1000)}s`); continue; }
      const f = st.files?.[0];
      refined.push({ seed: r.seed, ok: !!f, path: f?.localPath, metrics: f ? videoMetrics(f.localPath) : null });
      if (f) log(`seed ${r.seed} 精修完成 ${f.localPath}`);
      break;
    }
  }
}

const rec = writeSweepRecord(res, {
  name: cfg.name, sheet: sheet.ok ? sheet.path : null,
  note: refined.length
    ? '## 精修\n' + refined.map((r) => `- seed ${r.seed}: ${r.ok ? r.path : '失败'}${r.metrics ? `（锐度闪烁 ${r.metrics.flicker}）` : ''}`).join('\n')
    : null,
});
log(`记录 ${rec}`);

console.log('\n排名：');
for (const r of res.ranked) {
  console.log(`  #${r.rank} seed ${r.seed}  ${r.ok ? `分 ${r.metrics.score} · 闪烁 ${r.metrics.flicker} · 黑帧 ${r.metrics.blackRuns} · 切点 ${r.metrics.cuts}` : `失败 ${r.error}`}`);
}
if (refined.length) {
  console.log('\n精修：');
  for (const r of refined) console.log(`  seed ${r.seed}: ${r.ok ? r.path : '失败'}`);
}
