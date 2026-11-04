// tools/fix-mojibake.mjs — 修复「UTF-8 被当成 GBK 读、再写回 UTF-8」造成的乱码
//
// 事故背景（BUG-0011 复发）：用 PowerShell 的 `(Get-Content -Raw) -replace ... | Set-Content -Encoding utf8`
// 改中文源文件，读出时按 GBK 解码 → 每个 3 字节汉字变成 1.5 个 GBK 字；其中「第 3 个字节」如果紧跟
// ASCII（空格、引号、数字…）就无法配对，被替换成 '?'，字符信息在那一处永久丢失。
//
// 本工具做两件事：
//   1. 把留下的「GBK 乱码」整体还原回 UTF-8（这一步是无损的，能救回 99% 的文字）；
//   2. 对丢失的那 1 个字节，用「本文档自身的字频」做候选推断（同一份文档的用词就是最好的先验），
//      并在输出里标出推断置信度低的位置，供人工复核。
//
// 用法：
//   node tools/fix-mojibake.mjs --in mcp/server.mjs --out mcp/server.mjs.fixed [--report]
// 注意：永远先输出到新文件，人工/diff 确认后再替换原文件。
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const iconv = require('../mcp/node_modules/iconv-lite');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const inPath = arg('in');
const outPath = arg('out', inPath + '.fixed');
const report = process.argv.includes('--report');
const dumpPath = arg('dump');
const mapPath = arg('map');
if (!inPath) { console.error('需要 --in <文件>'); process.exit(2); }

const raw = readFileSync(inPath, 'utf8');

// 1) 当前字符串是「GBK 乱码」的 UTF-8 编码；按 GBK 重新编码就得到原始 UTF-8 字节流
//    （丢失的字节变成 0x3F，即 ASCII '?'）
const bytes = iconv.encode(raw, 'gbk');

// 2) 手写一个 UTF-8 走查器：把「3 字节字符的第 3 字节丢了」的地方标出来
function walkBytes(buf) {
  const out = []; // {type:'ok', ch} | {type:'loss', b1, b2}
  let i = 0;
  const cont = (b) => b >= 0x80 && b <= 0xBF;
  while (i < buf.length) {
    const b = buf[i];
    if (b < 0x80) { out.push({ type: 'ok', ch: String.fromCharCode(b) }); i += 1; continue; }
    if (b >= 0xC2 && b <= 0xDF && i + 1 < buf.length && cont(buf[i + 1])) {
      out.push({ type: 'ok', ch: Buffer.from([b, buf[i + 1]]).toString('utf8') }); i += 2; continue;
    }
    if (b >= 0xE0 && b <= 0xEF && i + 2 < buf.length && cont(buf[i + 1])) {
      if (cont(buf[i + 2])) {
        out.push({ type: 'ok', ch: Buffer.from([b, buf[i + 1], buf[i + 2]]).toString('utf8') }); i += 3; continue;
      }
      if (buf[i + 2] === 0x3F) { out.push({ type: 'loss', b1: b, b2: buf[i + 1] }); i += 3; continue; }
    }
    if (b >= 0xF0 && b <= 0xF4 && i + 3 < buf.length && cont(buf[i + 1]) && cont(buf[i + 2]) && cont(buf[i + 3])) {
      out.push({ type: 'ok', ch: Buffer.from([b, buf[i + 1], buf[i + 2], buf[i + 3]]).toString('utf8') }); i += 4; continue;
    }
    // 其它非法序列：原样保留一个字节，避免死循环
    out.push({ type: 'ok', ch: String.fromCharCode(b) }); i += 1;
  }
  return out;
}

const parts = walkBytes(bytes);

// 3) 字频先验：只用「没坏」的字符统计（同一份文档的用词就是最好的候选池）
const freq = new Map();
for (const p of parts) if (p.type === 'ok' && p.ch >= '\u4e00') freq.set(p.ch, (freq.get(p.ch) || 0) + 1);
const freqOf = (ch) => freq.get(ch) || 0;

// 4) 为每个丢失点选候选：UTF-8 前缀相同（b1,b2）、第 3 字节 0x80..0xBF 的所有字符
function candidates(b1, b2) {
  const list = [];
  for (let b3 = 0x80; b3 <= 0xBF; b3++) {
    const ch = Buffer.from([b1, b2, b3]).toString('utf8');
    if (ch.length !== 1 || ch.charCodeAt(0) === 0xFFFD) continue;
    list.push({ ch, n: freqOf(ch) });
  }
  return list.sort((a, b) => b.n - a.n);
}

const fixes = [];
// --map <json>：人工裁定表，按出现顺序给出每个丢失点应还原成哪个字（长度必须等于丢失点个数）
const manual = mapPath ? JSON.parse(readFileSync(mapPath, 'utf8')) : null;
let out = '';
for (let i = 0; i < parts.length; i++) {
  const p = parts[i];
  if (p.type === 'ok') { out += p.ch; continue; }
  const cands = candidates(p.b1, p.b2);
  const best = cands[0];
  const manualPick = manual ? manual[fixes.length] : null;
  const pick = manualPick || (best ? best.ch : '\uFFFD');
  const second = cands[1];
  const confident = best && best.n > 0 && (!second || best.n >= second.n * 2);
  fixes.push({
    at: out.length,
    left: out.slice(-8),
    right: parts.slice(i + 1, i + 8).map((x) => (x.type === 'ok' ? x.ch : '\uFFFD')).join(''),
    pick,
    confident,
    manual: manualPick !== null && manualPick !== undefined,
    top: cands.slice(0, 4).map((c) => `${c.ch}:${c.n}`).join(' '),
  });
  out += pick;
}

if (manual && manual.length !== fixes.length) {
  console.error(`裁定表长度 ${manual.length} 与丢失点个数 ${fixes.length} 不一致——先看 --dump 的编号再给表`);
  process.exit(3);
}
writeFileSync(outPath, out, 'utf8');
if (dumpPath) writeFileSync(dumpPath, JSON.stringify(fixes, null, 1), 'utf8');
const unsure = fixes.filter((f) => !f.confident && !f.manual);
console.log(JSON.stringify({
  in: inPath, out: outPath,
  total_losses: fixes.length,
  manual: fixes.filter((f) => f.manual).length,
  unsure: unsure.length,
  bytes_out: Buffer.byteLength(out),
}, null, 2));
if (report) {
  const rows = (unsure.length ? unsure : fixes).slice(0, 60)
    .map((f) => `  ${f.left}⟦${f.pick}⟧${f.right}   ${f.confident ? '' : '<-- 存疑'}  [${f.top}]`);
  console.log('\n修复点（' + (unsure.length ? '只列存疑的，' : '前 60 个，') + '左⟦选中⟧右）：\n' + rows.join('\n'));
}
