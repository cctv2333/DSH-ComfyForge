// tools/publish-workflows.mjs — 把我做的工作流「发布」成 ComfyUI 侧边栏里能直接点开的那几份
//
// 为什么单独有这个脚本：
//   2026-11-06 用户打开 ComfyUI 侧边栏，看到 82 个 `ComfyForge-<时间戳>-<哈希>.json`，
//   而我说「存好了」的模板一份都找不到 —— 因为模板存在仓库 workflows/ 里（API 格式），
//   ComfyUI 侧边栏只读 <ComfyUI>/user/default/workflows/ 且必须是 UI 格式。
//   于是「我说存了」和「他看得见」之间断了一节。这个脚本就是那一节。
//
// 用法：
//   node tools/publish-workflows.mjs             # 体检 + 写进 ComfyUI
//   node tools/publish-workflows.mjs --dry-run   # 只体检不写
//   node tools/publish-workflows.mjs --list      # 只列出这份清单
//   node tools/publish-workflows.mjs --clean     # 顺手清掉按次自动落盘的旧文件
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { COMFY_ROOT, RUNS_DIR, PROJECT_ROOT } from '../mcp/lib/config.mjs';
import { apiToUiGraph, applyTemplateDefaults, auditUiGraph } from '../mcp/lib/uitograph.mjs';

const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');

if (!COMFY_ROOT) {
  console.error('不知道 ComfyUI 装在哪（COMFY_ROOT 为空）。设 COMFY_ROOT 或写 comfyforge.config.json。');
  process.exit(2);
}
const OUT_DIR = join(COMFY_ROOT, 'user', 'default', 'workflows');

// 三视图那次成功运行的 id（25 节点、ImageStitch ×2、出 2496×1216）
const THREEVIEW_RUN = '02f9bf02-d83b-4867-be6e-c15f35fbde69';

/**
 * 发布清单。顺序 = 侧边栏里的顺序（前缀编号保证稳定）。
 * kind=run      ：从 runs/live/<id>.json 的真实执行图取 —— 那是**真的跑出过图**的图，最可信。
 * kind=template ：从仓库 workflows/*.json 取，按 defaults 填好再转（否则打开是空提示词）。
 */
const PUBLISH = [
  { kind: 'run', id: THREEVIEW_RUN, out: '01-三视图-FLUX2.json', title: '三视图 · FLUX2 一条图出正/侧/背并拼合' },
  { kind: 'template', file: 'moss_t2i.json', out: '02-文生图-MOSS.json' },
  { kind: 'template', file: 'krea2_t2i.json', out: '03-文生图-Krea2.json' },
  { kind: 'template', file: 'flux2_t2i.json', out: '04-文生图-FLUX2.json' },
];

function loadGraph(item) {
  if (item.kind === 'run') {
    const p = join(RUNS_DIR, 'live', `${item.id}.json`);
    if (!existsSync(p)) throw new Error(`找不到运行记录 ${p}`);
    const rec = JSON.parse(readFileSync(p, 'utf8'));
    if (!rec.graph) throw new Error(`运行记录 ${item.id} 没有 graph`);
    return { workflow: rec.graph, name: item.out, title: item.title || rec.label || '', rec };
  }
  const p = join(PROJECT_ROOT, 'workflows', item.file);
  if (!existsSync(p)) throw new Error(`找不到模板 ${p}`);
  const tpl = JSON.parse(readFileSync(p, 'utf8'));
  const { workflow, applied } = applyTemplateDefaults(tpl);
  return { workflow, name: tpl.name || item.out, title: tpl.title || '', applied };
}

const AUTO_DUMP = /^ComfyForge-\d{8}-\d{6}-[0-9a-f]{8}\.json$/;

if (argv.includes('--list')) {
  for (const it of PUBLISH) {
    console.log(`${it.out}  ←  ${it.kind === 'run' ? `runs/live/${it.id}.json` : `workflows/${it.file}`}`);
  }
  process.exit(0);
}

// —— 顺手清掉按次自动落盘的旧文件（只认这个固定命名模式，别的绝不碰）——
if (argv.includes('--clean')) {
  let n = 0;
  for (const f of existsSync(OUT_DIR) ? readdirSync(OUT_DIR) : []) {
    if (!AUTO_DUMP.test(f)) continue;
    if (!DRY) unlinkSync(join(OUT_DIR, f));
    n++;
  }
  console.log(`清理按次落盘的旧文件：${n} 份${DRY ? '（dry-run 未删）' : ''}`);
}

const info = await (await fetch(COMFY + '/object_info')).json().catch(() => null);
if (!info || Object.keys(info).length < 100) {
  console.error('拿不到 /object_info，或 ComfyUI 没起（先 comfy_health）');
  process.exit(2);
}

let bad = 0;
const done = [];
for (const item of PUBLISH) {
  let loaded;
  try { loaded = loadGraph(item); } catch (e) { console.error(`✗ ${item.out}: ${e.message}`); bad++; continue; }
  const { workflow, name, title, applied } = loaded;
  const ui = apiToUiGraph(workflow, info, { name, title });
  if (!ui) { console.error(`✗ ${item.out}: 转换结果是空的`); bad++; continue; }
  const problems = auditUiGraph(ui, info);
  console.log(`${problems.length ? '✗' : '✓'} ${item.out}  ${ui.nodes.length} 节点 / ${ui.last_link_id} 连线` +
    (applied?.length ? `  （填入默认值 ${applied.length} 处）` : ''));
  for (const p of problems) console.log(`    · ${p}`);
  if (problems.length) bad++;
  else done.push(item.out);

  if (!DRY && !problems.length) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, item.out), JSON.stringify(ui, null, 2), 'utf8');
  }
}

if (existsSync(OUT_DIR)) {
  const left = readdirSync(OUT_DIR).filter((f) => f.endsWith('.json'));
  const mine = new Set(done);
  const other = left.filter((f) => !mine.has(f));
  if (other.length) {
    console.log(`\n目录里还有 ${other.length} 份不是我发布的（他自己的存档等，没动）：`);
    for (const f of other.slice(0, 10)) console.log(`  · ${f}`);
    if (other.length > 10) console.log(`  · …还有 ${other.length - 10} 份`);
  }
}

console.log(DRY ? '\n（dry-run，未写入）' : `\n已写入 ${OUT_DIR}`);
process.exit(bad ? 1 : 0);
