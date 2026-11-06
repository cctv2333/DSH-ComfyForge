// tools/check-hardcoded.mjs — 防止「在我机器上能跑」的绝对路径混进仓库
//
// 为什么要它：2026-11-06 用户担心「硬编码写死我电脑的环境」，
// 而这类问题一旦发出去，别人的表现是**静默失效**（面板不出来、产物为空），
// 不是报错。靠人记不住，所以做成检查 + 进单测。
//
// 判据：扫 git 跟踪的源码文件，找 `X:\…` / `X:/…` 这种绝对路径。
// 允许的例外（都不会误报）：
//   · URL 里的（http:// https://）—— 前面不是单个盘符
//   · 正则里转义过的（\\）
//   · 同一行带 `hardcode-ok` 标记的（说明为什么必须写死）
//
// 用法：
//   node tools/check-hardcoded.mjs            # 扫全部跟踪文件
//   node tools/check-hardcoded.mjs --all      # 连 docs / prompts 一起扫（默认跳过，文档里举例无害）
// 退出码：0 干净 / 1 有命中
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const SCAN_DOCS = argv.includes('--all');

const CODE = /\.(mjs|js|cjs|ts|json|ya?ml|cmd|ps1|sh)$/i;
const DOC = /\.(md|txt)$/i;

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);

// 这些路径本来就该是机器相关的，跳过（都被 gitignore，保险起见再排一次）
const SKIP = [/^runs\//, /^\.cache\//, /^backups\//, /^node_modules\//, /^out\//];

// 形如 D:\x 或 C:/x。注意 JS 源码里反斜杠是**转义过的**（`'D:\\vidlens\\...'`），
// 所以先把双反斜杠还原成单反斜杠再匹配，否则会漏掉最重要的那类命中。
const ABS = /(^|[^A-Za-z0-9_/])([A-Za-z]:[\\/])([^\s'"`),;]{1,90})/g;

/** 这一行是不是注释（注释里举路径例子无害，不该算违规） */
function isCommentLine(line, matchIndex) {
  const t = line.trimStart();
  if (/^(#|\/\/|\*|\/\*|<!--)/.test(t)) return true;
  const before = line.slice(0, matchIndex);
  const hash = before.lastIndexOf('#');
  const slashes = before.lastIndexOf('//');
  // yml/json 用 #，js 用 //；只要匹配点之前出现过就是注释
  return hash >= 0 || slashes >= 0;
}

const hits = [];
const notes = [];
for (const f of files) {
  if (SKIP.some((re) => re.test(f))) continue;
  const isCode = CODE.test(f);
  const isDoc = DOC.test(f);
  if (!isCode && !(SCAN_DOCS && isDoc)) continue;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes('hardcode-ok')) continue; // 显式豁免
    const probe = line.replace(/\\\\/g, '\\');   // 还原转义，才能认出 'D:\\x' 这类
    ABS.lastIndex = 0;
    const found = [];
    let m;
    while ((m = ABS.exec(probe)) !== null) {
      const full = `${m[2]}${m[3]}`;
      // 只把**正斜杠双斜杠**当 URL（http:// file://）。反斜杠双斜杠 `E:\\x`
      // 恰恰是 JS 源码里转义过的 Windows 路径，不能放过——放过了会漏掉最主要的那类。
      if (/^[A-Za-z]:\/\//.test(full)) continue; // URL
      found.push({ value: full, at: m.index });
    }
    if (!found.length) continue;
    const real = found.filter((x) => !isCommentLine(line, x.at));
    if (real.length) hits.push({ file: f, line: i + 1, text: real.map((x) => x.value).join(', ').slice(0, 100) });
    else notes.push({ file: f, line: i + 1, text: found.map((x) => x.value).join(', ').slice(0, 80) });
  }
}

if (!hits.length) {
  console.log(`干净：${files.length} 个跟踪文件里没有**代码**写死的本机绝对路径。`);
  if (notes.length) console.log(`（另有 ${notes.length} 处在注释/示例里，不计违规——那些是给人看的说明。）`);
  process.exit(0);
}

console.log(`发现 ${hits.length} 处**代码里**写死的绝对路径：\n`);
for (const h of hits) console.log(`  ${h.file}:${h.line}\n      ${h.text}`);
console.log('\n改法（按优先级）：');
console.log('  1) 用 lib/config.mjs 里解析出来的值（COMFY_ROOT / PROJECT_ROOT / OUTPUT_DIR / PYTHON…）');
console.log('  2) 用环境变量兜底：process.env.XXX || 探测');
console.log('  3) 真的必须写死时，在那一行加注释 hardcode-ok: 原因');
console.log('\n为什么必须改：这类值在别人机器上不会报错，只会**静默失效**（面板不出现、产物为空）。');
process.exit(1);
