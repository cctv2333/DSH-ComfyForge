// tools/cleanup.mjs — 清垃圾。分三档，只动「派生/可重生成/重复」的东西。
//
// 为什么要有它：跑一阵子之后磁盘上会堆三类东西 ——
//   1. 缓存：抽出来的视频帧、拼图、预览、评分对比图。全是**派生**的，删了能重算。
//   2. 重复：面板每跑一次自动落盘的 UI 图，`runs/live` 里已有同一次执行的记录。
//   3. 实验产物：我为了比对 A/B 跑的成批小图，混在正式产物里，看着乱。
//
// 三档分别对应：删 / 删（唯一的那份留着）/ 移进 `output/_archive/`（不删）。
//
// 绝对不动的：video / music / h3film / h3pilot / h3res / h3test / cyber / anime /
//             curate / cn / _archive、所有模型、所有工作流。
//
// 用法：
//   node tools/cleanup.mjs                 # dry-run，只报告
//   node tools/cleanup.mjs --apply         # 真删 + 真移
//   node tools/cleanup.mjs --apply --only cache
import { existsSync, readdirSync, statSync, rmSync, mkdirSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, COMFY_ROOT } from '../mcp/lib/config.mjs';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

const OUT = COMFY_ROOT ? join(COMFY_ROOT, 'output') : null;
const INP = COMFY_ROOT ? join(COMFY_ROOT, 'input') : null;

/** 递归统计体积与文件数 */
function measure(target) {
  let bytes = 0, files = 0;
  const walk = (p) => {
    let es;
    try { es = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = join(p, e.name);
      let st;
      try { st = statSync(f); } catch { continue; }
      if (st.isDirectory()) walk(f);
      else { bytes += st.size; files++; }
    }
  };
  try { if (statSync(target).isFile()) return { bytes: statSync(target).size, files: 1 }; } catch { return { bytes: 0, files: 0 }; }
  walk(target);
  return { bytes, files };
}

const MB = (b) => (b / 1048576).toFixed(1) + 'MB';
const report = [];
let freed = 0;

/** 第一档：整目录或整个通配集合删掉 */
function purge(label, targets) {
  const live = targets.filter((t) => existsSync(t));
  if (!live.length) return;
  let bytes = 0, files = 0;
  for (const t of live) { const m = measure(t); bytes += m.bytes; files += m.files; }
  if (APPLY) for (const t of live) { try { rmSync(t, { recursive: true, force: true }); } catch { /* 占用中就跳过 */ } }
  freed += bytes;
  report.push({ tier: '删', label, items: live.length, files, bytes });
}

/** 第二档：目录里的文件，只挑名字匹配的 */
function purgeMatching(label, dir, test) {
  if (!existsSync(dir)) return;
  let bytes = 0, n = 0;
  for (const name of readdirSync(dir)) {
    if (!test(name)) continue;
    const f = join(dir, name);
    let st;
    try { st = statSync(f); } catch { continue; }
    bytes += st.size; n++;
    if (APPLY) { try { rmSync(f, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  if (!n) return;
  freed += bytes;
  report.push({ tier: '删', label, items: n, files: n, bytes });
}

/** 第三档：移进归档，不删 */
function archive(label, dir, test, destRoot) {
  if (!existsSync(dir)) return;
  const picked = readdirSync(dir).filter(test);
  if (!picked.length) return;
  const dest = join(destRoot, label);
  let bytes = 0, n = 0;
  if (APPLY) mkdirSync(dest, { recursive: true });
  for (const name of picked) {
    const src = join(dir, name);
    let st;
    try { st = statSync(src); } catch { continue; }
    const m = measure(src);
    bytes += m.bytes; n++;
    if (APPLY) {
      try { renameSync(src, join(dest, name)); } catch {
        // 跨盘或占用中：退化成复制 + 删（这里只处理移动，失败就留着，绝不硬删）
        report.push({ tier: '!', label, items: 1, files: 1, bytes: 0, note: `移不动：${name}` });
      }
    }
  }
  if (!n) return;
  report.push({ tier: '移', label: `→ _archive/${label}`, items: n, files: n, bytes });
}

const want = (k) => !ONLY || ONLY === k;

// ---------------------------------------------------------------- 1. 缓存
if (want('cache')) {
  // 例外：docs/模型选型-2026-11-06.md 把 .cache/compare/ 当「模型排序的证据」引用着，
  // 删了那份文档就没有图可看 —— 所以这一格留着，其余全清。
  const cacheRoot = join(PROJECT_ROOT, '.cache');
  if (existsSync(cacheRoot)) {
    const keep = new Set(['compare']);
    const victims = readdirSync(cacheRoot).filter((n) => !keep.has(n)).map((n) => join(cacheRoot, n));
    purge('.cache（抽帧/拼图/预览/评分，全部可重算；保留 compare/）', victims);
  }
  if (OUT) purge('output/clipscore（每次评分的对比图）', [join(OUT, 'clipscore')]);
  if (INP) purge('input/clipscore（评分用的临时上传）', [join(INP, 'clipscore')]);
  if (INP) {
    purgeMatching('input 里的临时上传（describe_/src_/replace_）', INP,
      (n) => /^(describe_|src_|replace_src_|replace_clean_|mask_|tmp_)/.test(n));
  }
}

// ---------------------------------------------------------------- 2. 重复
if (want('dump')) {
  const dumpDir = join(PROJECT_ROOT, 'runs', 'workflows-dump');
  const liveDir = join(PROJECT_ROOT, 'runs', 'live');
  // 只有 runs/live 里有同一次执行记录的才删；没有对应记录的是唯一留存，留着
  const known = new Set(
    existsSync(liveDir) ? readdirSync(liveDir).map((f) => f.replace(/\.json$/, '').slice(0, 8)) : [],
  );
  purgeMatching('runs/workflows-dump（可由 runs/live 重建的）', dumpDir, (n) => {
    const m = n.match(/-([0-9a-f]{8})\.json$/);
    return Boolean(m && known.has(m[1]));
  });
  // 活动日志轮转：只留最后 2000 行
  const act = join(PROJECT_ROOT, 'runs', 'activity.jsonl');
  if (existsSync(act)) {
    const lines = readFileSync(act, 'utf8').split('\n');
    const keep = 2000;
    if (lines.length > keep + 500) {
      const trimmed = lines.slice(-keep).join('\n');
      const saved = measure(act).bytes - Buffer.byteLength(trimmed);
      if (APPLY) writeFileSync(act, trimmed, 'utf8');
      freed += Math.max(0, saved);
      report.push({ tier: '删', label: `activity.jsonl 轮转（${lines.length}→${keep} 行）`, items: 1, files: 1, bytes: Math.max(0, saved) });
    }
  }
}

// ---------------------------------------------------------------- 3. 实验产物
if (want('experiments') && OUT) {
  const base = join(OUT, 'comfyforge');
  // 这些子目录是我为比对/扫参跑的成批小图，不是交付物
  const EXPERIMENTS = ['ab', 'compare', 'sweep', 'sweep-ip', 'qwen', 'qwen3v', 'flux2', 'flux2v', 'moss3v2', '3view', '2pass-test', 'bund', 'sheet', 'whale_maid'];
  archive('experiments-2026-11-06', base, (n) => EXPERIMENTS.includes(n), join(OUT, '_archive'));
}

// ---------------------------------------------------------------- 报告
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${APPLY ? '已执行' : '计划（dry-run，未动任何文件）'}\n`);
for (const r of report.sort((a, b) => b.bytes - a.bytes)) {
  console.log(` ${r.tier}  ${pad(r.label, 46)} ${String(r.items).padStart(4)} 项 / ${pad(r.files, 5)} 文件  ${MB(r.bytes).padStart(9)}`);
  if (r.note) console.log(`      ${r.note}`);
}
console.log(`\n合计${APPLY ? '释放' : '可释放'} ${MB(freed)}`);
if (!APPLY) console.log('确认无误后加 --apply 执行。');

// 清理后复测三个主要目录
if (APPLY) {
  for (const [n, d] of [['.cache', join(PROJECT_ROOT, '.cache')], ['output', OUT], ['input', INP]]) {
    if (d && existsSync(d)) console.log(`  现在 ${pad(n, 8)} ${MB(measure(d).bytes)}`);
  }
}
