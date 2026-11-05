#!/usr/bin/env node
// tools/model-slots.mjs —— 查一个工作流要哪些模型、本机有没有、没有的话有什么候选
//
// 用法：
//   node tools/model-slots.mjs --workflow workflows/flux_t2i.json
//   node tools/model-slots.mjs --workflow <UI 或 API 格式的 json> [--json]
//
// 只读，不改工作流。换不换、换哪个，由人或 AI 决定。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { analyzeModelSlots, formatSlotReport } from '../mcp/lib/modelslots.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

const wfPath = arg('workflow', null);
if (!wfPath) {
  console.error('用法: node tools/model-slots.mjs --workflow <工作流 json> [--json]');
  process.exit(2);
}

const doc = JSON.parse(readFileSync(resolve(wfPath), 'utf8'));
// 模板文件是 {workflow:{...}, bindings:{...}}；也接受直接的 API 图
const graph = doc.workflow || doc;
const res = analyzeModelSlots(graph);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(res, null, 2));
} else {
  console.log(`\n工作流：${wfPath}`);
  console.log(formatSlotReport(res));
  console.log('');
}
