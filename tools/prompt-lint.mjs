#!/usr/bin/env node
// prompt-lint.mjs — 发出去之前先自查提示词（规则层，默认不联网、不下载任何东西）
//
// 用法:
//   node tools/prompt-lint.mjs <提示词文件> [--seconds=15] [--images=1] [--llm] [--json]
//
//   <提示词文件>  纯文本，或带 prompt 字段的 JSON 配置
//   --seconds     目标时长（校验帧数 5+17k、末尾时间码、字数密度）
//   --images      实际给了几张参考图（校验 <Picture n> 引用是否对得上）
//   --llm         额外跑语义层（需要本地 Ollama / llama.cpp 端点；没有就打印装法，不自动下）
//   --json        只输出 JSON（给别的工具吃）
import { lintPrompt, lintWithLLM, readPromptFile, LLM_SETUP } from '../mcp/lib/promptlint.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node tools/prompt-lint.mjs <提示词文件> [--seconds=15] [--images=1] [--llm] [--json]');
  process.exit(2);
}
const flag = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
};
const has = (name) => args.includes(`--${name}`);
const seconds = flag('seconds') ? +flag('seconds') : undefined;
const images = flag('images') ? +flag('images') : undefined;

const { text, meta } = readPromptFile(file);
const sec = seconds ?? meta.seconds;
const rep = lintPrompt(text, { seconds: sec, refImages: images });

let llm = null;
if (has('llm')) {
  llm = await lintWithLLM(text);
  if (!llm.skipped) rep.issues.push(...llm.issues);
}

if (has('json')) {
  console.log(JSON.stringify({ ...rep, llm: llm && (llm.skipped ? { skipped: llm.reason } : { model: llm.model }) }, null, 2));
  process.exit(rep.ok ? 0 : 1);
}

const mark = { error: '[错误]', warn: '[警告]', info: '[提示]' };
const colors = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', reset: '\x1b[0m' };

console.log(`\n提示词体检：${file}${sec ? `（目标 ${sec}s）` : ''}`);
console.log(`分数 ${rep.score}/100 · ${rep.ok ? '可以发' : '有错误，先改'}`);
console.log(`字数 ${rep.stats.chars}${rep.stats.charsPerSecond ? `（${rep.stats.charsPerSecond} 字/秒）` : ''}` +
  ` · 段 ${rep.stats.sections.length} 个 · 分镜 ${rep.stats.shots} · 参考图 ${rep.stats.pictures}`);

const order = { error: 0, warn: 1, info: 2 };
for (const it of [...rep.issues].sort((a, b) => order[a.level] - order[b.level])) {
  const c = colors[it.level] || '';
  console.log(`\n${c}${mark[it.level] || ''} ${it.msg}${colors.reset}`);
  if (it.hint) console.log(`        → ${it.hint}`);
}

if (llm?.skipped) {
  console.log(`\n[语义层未运行：${llm.reason}]\n${LLM_SETUP}`);
} else if (llm && !llm.skipped) {
  console.log(`\n语义层：${llm.model} @ ${llm.endpoint}，${llm.issues.length} 条建议`);
}

const errs = rep.issues.filter((i) => i.level === 'error').length;
const warns = rep.issues.filter((i) => i.level === 'warn').length;
console.log(`\n合计：${errs} 错误 / ${warns} 警告 / ${rep.issues.length - errs - warns} 提示\n`);
process.exit(rep.ok ? 0 : 1);
