#!/usr/bin/env node
// archive.mjs — 查/看/搜/重放 每次工作的档案
//
//   node tools/archive.mjs list [n]          最近 n 次
//   node tools/archive.mjs show <id>         看完整记录（含工作流图的结构摘要）
//   node tools/archive.mjs search <关键词>   在 goal/verdict/lesson/tags 里搜
//   node tools/archive.mjs replay <id>       导出成可重跑的脚本
//   node tools/archive.mjs stats             按类型统计
import { loadAll, get, search, stats, exportScript } from '../mcp/lib/archive.mjs';

const [, , cmd, arg1] = process.argv;

function brief(r) {
  const arms = r.arms?.length ? ` · ${r.arms.length} 组` : '';
  return `${r.id}\n   目标：${r.goal || '—'}${arms}\n   结论：${r.verdict || '—'}${r.lesson ? `\n   教训：${r.lesson}` : ''}`;
}

function graphDigest(wf) {
  if (!wf) return '（没保存工作流）';
  const byType = {};
  for (const [id, n] of Object.entries(wf)) {
    (byType[n.class_type] ||= []).push(id);
  }
  return Object.entries(byType).map(([t, ids]) => `  #${ids.join(',')} ${t}`).join('\n');
}

if (cmd === 'list' || !cmd) {
  const n = +(arg1 || 10);
  const rows = loadAll().slice(-n).reverse();
  if (!rows.length) { console.log('还没有档案。跑任意工具时带上归档就会写入。'); process.exit(0); }
  console.log(`共 ${loadAll().length} 条，最近 ${rows.length} 条：\n`);
  for (const r of rows) console.log(brief(r) + '\n');
} else if (cmd === 'show') {
  const r = get(arg1);
  if (!r) { console.error(`没有这条：${arg1}`); process.exit(1); }
  console.log(`${r.id}  ${r.ts}\n类型：${r.kind}\n目标：${r.goal}`);
  console.log(`\n参数：${JSON.stringify(r.params, null, 1)}`);
  if (r.arms?.length) {
    console.log('\n分组：');
    for (const a of r.arms) {
      console.log(`  · ${a.name}${a.changes ? ` — ${a.changes}` : ''}`);
      if (a.metrics) console.log(`      指标 ${JSON.stringify(a.metrics)}`);
      if (a.outputs?.length) console.log(`      产物 ${a.outputs.map((o) => String(o).split(/[\\/]/).pop()).join(', ')}`);
    }
  }
  if (Object.keys(r.metrics || {}).length) console.log(`\n汇总指标：${JSON.stringify(r.metrics, null, 1)}`);
  console.log(`\n结论：${r.verdict || '—'}\n教训：${r.lesson || '—'}`);
  console.log(`\n工作流结构：\n${graphDigest(r.workflow)}`);
  if (r.outputs?.length) console.log(`\n产物：\n${r.outputs.map((o) => '  ' + o).join('\n')}`);
} else if (cmd === 'search') {
  const rows = search(arg1);
  console.log(`命中 ${rows.length} 条：\n`);
  for (const r of rows) console.log(brief(r) + '\n');
} else if (cmd === 'replay') {
  const p = exportScript(arg1, `.cache/replay-${arg1}.mjs`);
  console.log(`已导出：${p}\n跑它：node ${p}`);
} else if (cmd === 'stats') {
  const s = stats();
  console.log(`总记录 ${s.total} 条 · ${s.file}\n`);
  for (const [k, v] of Object.entries(s.byKind)) console.log(`  ${k}: ${v.count} 次`);
} else {
  console.error('未知命令。可用：list / show / search / replay / stats');
  process.exit(2);
}
