#!/usr/bin/env node
// check-workflow.mjs — 工作流缺件体检（CLI 壳）
//
// 判定逻辑已经下沉到 mcp/lib/workflowcheck.mjs，MCP 工具 comfy_check_workflow 用的是同一份代码。
//
// 用法:
//   node tools/check-workflow.mjs <workflow.json|目录> [--json]
//   node tools/check-workflow.mjs <file> --comfy http://127.0.0.1:8188
//
// 判定三档：
//   A 已装未加载（重启即可） / B 未安装（给仓库地址） / C 来源未知（人工确认）
// 只读：不写 ComfyUI 目录、不装任何东西。

import { checkWorkflows, formatReport } from '../mcp/lib/workflowcheck.mjs';

const args = process.argv.slice(2);
const targets = [];
let asJson = false;
let comfyUrl = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') asJson = true;
  else if (a === '--comfy') comfyUrl = args[++i];
  else if (!a.startsWith('--')) targets.push(a);
}

if (!targets.length) {
  console.error('usage: node tools/check-workflow.mjs <workflow.json|dir> [--json] [--comfy URL]');
  process.exit(2);
}

if (comfyUrl) process.env.COMFY_BASE = comfyUrl;

try {
  const res = await checkWorkflows(targets);
  if (asJson) console.log(JSON.stringify(res, null, 2));
  else console.log(formatReport(res));
  process.exit(res.totalMissing ? 1 : 0);
} catch (e) {
  console.error('check-workflow failed:', e.message);
  process.exit(2);
}
