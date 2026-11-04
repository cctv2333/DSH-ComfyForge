// tools/make-sheet.mjs — 生成带标题/seed 的对比表（精选用）
// node tools/make-sheet.mjs --dir cyber --prefix inside --title "..." --subtitle "..." --out .cache/sheets/x.jpg
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT_DIR, PROJECT_ROOT } from '../mcp/lib/config.mjs';
import { pythonPath } from '../mcp/lib/img.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const dirName = arg('dir', '');
const prefix = arg('prefix', '');
const title = arg('title', '');
const subtitle = arg('subtitle', '');
const out = arg('out', join(PROJECT_ROOT, '.cache', 'sheets', `${dirName || 'output'}-${prefix || 'all'}.jpg`));
const cols = arg('cols', '2');
const cell = arg('cell', '620');

if (!OUTPUT_DIR) {
  console.error('不知道 ComfyUI 产物目录：设 COMFY_ROOT 或 COMFY_OUTPUT_DIR，或跑 node mcp/doctor.mjs');
  process.exit(2);
}
const OUTROOT = OUTPUT_DIR;
const dir = dirName ? join(OUTROOT, dirName) : OUTROOT;
const files = readdirSync(dir).filter((f) => f.endsWith('.png') && f.startsWith(prefix)).sort();
if (!files.length) { console.error(`没有匹配的图：${dir} prefix="${prefix}"`); process.exit(1); }

// 从运行记录里找 seed（文件 → seed）
const seeds = {};
const runsDir = join(PROJECT_ROOT, 'runs');
for (const f of existsSync(runsDir) ? readdirSync(runsDir) : []) {
  try {
    const r = JSON.parse(readFileSync(join(runsDir, f), 'utf8'));
    for (const o of r.outputs || []) {
      if (o.subfolder === dirName && files.includes(o.filename) && r.params?.seed !== undefined) {
        seeds[o.filename] = r.params.seed;
      }
    }
  } catch { /* ignore */ }
}

const metaPath = join(PROJECT_ROOT, '.cache', `meta-${dirName || 'output'}-${prefix || 'all'}.json`);
const meta = { title, subtitle, seeds };
writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

const py = pythonPath();
const script = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'mcp', 'scripts', 'imgops.py');
const stdout = execFileSync(py, [script, 'sheet', '--out', out, '--cols', cols, '--cell', cell, '--meta', metaPath, ...files.map((f) => join(dir, f))], { encoding: 'utf8' });
const res = JSON.parse(stdout.trim().split(/\r?\n/).pop());
console.log(JSON.stringify({ out: res.out, count: res.count, seeds, files }));
