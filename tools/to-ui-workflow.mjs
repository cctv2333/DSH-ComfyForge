// tools/to-ui-workflow.mjs — 把 API 格式的工作流（我搭的图）转成 ComfyUI 前端能打开的 UI 格式
//
// 用法：node tools/to-ui-workflow.mjs --template workflows/moss_t2i.json --out out.json
// 转换与体检逻辑都在 mcp/lib/uitograph.mjs，这里只做 I/O。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { apiToUiGraph, applyTemplateDefaults, auditUiGraph } from '../mcp/lib/uitograph.mjs';

const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

const tplPath = arg('template');
const outPath = arg('out');
if (!tplPath || !outPath) { console.error('需要 --template 与 --out'); process.exit(2); }

const tpl = JSON.parse(readFileSync(tplPath, 'utf8'));
// 模板（带 bindings/defaults）先把默认值填进去，打开时才是真实可跑的提示词，而不是空串
const workflow = tpl.workflow ? applyTemplateDefaults(tpl).workflow : tpl;

const info = await (await fetch(COMFY + '/object_info')).json();
const ui = apiToUiGraph(workflow, info, { name: tpl.name, title: tpl.title });
if (!ui) { console.error('工作流是空的'); process.exit(1); }

const problems = auditUiGraph(ui, info);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(ui, null, 2), 'utf8');
console.log(JSON.stringify({ out: outPath, nodes: ui.nodes.length, links: ui.last_link_id, name: tpl.name, problems }, null, 2));
if (problems.length) process.exit(3);
