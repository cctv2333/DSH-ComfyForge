// tools/transition.mjs —— 命令行入口：把「A 变成 B」编译成模型画得出来的空间描述
//
// 为什么不直接手写提示词：
//   同一个错误会一遍遍重犯——写「一只鼠标正在变成老鼠」，模型给你两个东西并排。
//   把"分区归属 / 交界机制 / 必须不变的特征"变成有默认值、有校验、能复用的结构，
//   才不会每次从零想。
//
// 用法：
//   node tools/transition.mjs --list
//   node tools/transition.mjs --example mouse
//   node tools/transition.mjs --from "白色塑料鼠标" --to "灰毛家鼠" --progress 0.6 \
//        --axis near->far --boundary crack --to-detail "短灰毛、粉耳、细长裸尾"
//   node tools/transition.mjs spec.json          # 整份 spec（可含多主体）
//   node tools/transition.mjs spec.json --json   # 只要机器可读的结果
//
// 退出码：0 成功 / 1 编译失败（参数问题）/ 2 读文件失败
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { PROJECT_ROOT } from '../mcp/lib/config.mjs';
import {
  buildTransition, formatTransitionReport, describeOptions, EXAMPLES,
  AXES, BOUNDARIES, STYLES,
} from '../mcp/lib/transition.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const val = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return dflt;
  return v;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1] || !argv[i - 1].startsWith('--')));

if (flag('--help') || flag('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 20).join('\n'));
  process.exit(0);
}

if (flag('--list')) {
  console.log(describeOptions());
  console.log('\n—— 现成例子 ——');
  for (const [k, v] of Object.entries(EXAMPLES)) console.log(`  ${k.padEnd(9)} ${v.label}`);
  console.log('\n用 --example <名字> 直接编译一个看效果。');
  process.exit(0);
}

const exName = val('--example');
if (exName) {
  const ex = EXAMPLES[exName];
  if (!ex) {
    console.error(`没有叫 "${exName}" 的例子。现有：${Object.keys(EXAMPLES).join(', ')}`);
    process.exit(1);
  }
  const r = buildTransition(ex.spec);
  if (flag('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  console.log(`# 例子：${ex.label}\n`);
  console.log(formatTransitionReport(r, ex.spec));
  process.exit(0);
}

// 读 spec：优先命令行位置参数，其次纯 flag
let spec = null;
const specPath = positional.find((p) => /\.json$/i.test(p));
if (specPath) {
  const p = isAbsolute(specPath) ? specPath : join(PROJECT_ROOT, specPath);
  if (!existsSync(p)) { console.error(`找不到 spec 文件：${p}`); process.exit(2); }
  try {
    // 中文 Windows 上的编辑器（记事本、PowerShell 的 Set-Content）常常写成带 BOM 的 UTF-8，
    // 直接 JSON.parse 会报 "Unexpected token ﻿"。这里先剥掉 BOM——这不是宽容，是必须。
    spec = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error(`spec 解析失败：${e.message}`);
    process.exit(2);
  }
} else {
  spec = {
    from: val('--from'),
    to: val('--to'),
  };
  if (!spec.from && !spec.to) {
    console.error('需要 --from 和 --to（或给一份 spec.json、或用 --example）。\n先跑 --list 看可选值。');
    process.exit(1);
  }
  const num = (k) => (val(k) === undefined ? undefined : Number(val(k)));
  const list = (k) => {
    const v = val(k);
    return v === undefined ? undefined : v.split(/[,，;；]/).map((x) => x.trim()).filter(Boolean);
  };
  Object.assign(spec, {
    fromDetail: val('--from-detail'),
    toDetail: val('--to-detail'),
    fromFeature: val('--from-feature'),
    toFeature: val('--to-feature'),
    progress: num('--progress'),
    axis: val('--axis'),
    boundary: val('--boundary'),
    keep: list('--keep'),
    scene: val('--scene'),
    style: val('--style'),
    canvas: val('--canvas'),
    lang: val('--lang'),
  });
  for (const k of Object.keys(spec)) if (spec[k] === undefined) delete spec[k];
}

if (spec.axis && !AXES[spec.axis]) {
  console.error(`--axis "${spec.axis}" 不认识。可用：\n  ` + Object.keys(AXES).join('  '));
  process.exit(1);
}
if (spec.boundary && !BOUNDARIES[spec.boundary]) {
  console.error(`--boundary "${spec.boundary}" 不认识。可用：\n  ` + Object.keys(BOUNDARIES).join('  '));
  process.exit(1);
}
if (spec.style && !STYLES[spec.style]) {
  console.error(`注意：--style "${spec.style}" 不在预置里（${Object.keys(STYLES).join('/')}），会原样当自由文本拼进去。`);
}

let r;
try {
  r = buildTransition(spec);
} catch (e) {
  console.error('✗ ' + e.message);
  if (e.warnings?.length) { console.error('\n另外：'); for (const w of e.warnings) console.error('  ⚠ ' + w); }
  process.exit(1);
}

if (flag('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
console.log(formatTransitionReport(r, spec));
