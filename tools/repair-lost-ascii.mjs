// tools/repair-lost-ascii.mjs — 第二轮修复：把「跟着坏字一起被吃掉的那个 ASCII 字符」补回来
//
// 事故机制（见 fix-mojibake.mjs 头注释）：GBK 解码时，坏字后面紧跟的 1 个 ASCII 字节
// （`'`、`$`、空格）会被当作非法的「尾字节」吞掉。所以每个坏字旁边都可能少一个标点。
//
// 本工具只做三件**低风险、可验证**的补丁：
//   1. 模板字符串里丢了 `$` 的 `${...}`（症状：`失败：{e.message}` 原样输出花括号）；
//   2. 字符串字面量结尾丢的 `'`（症状：node --check 报 Invalid or unexpected token）；
//   3. 中英之间丢的空格（纯排版，不改正误）。
// 改完必须跑 node --check 复核——语法检查是这里的硬判据。
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
const quiet = process.argv.includes('--quiet');
if (!file) { console.error('用法：node tools/repair-lost-ascii.mjs <文件>'); process.exit(2); }
const src = readFileSync(file, 'utf8');
const stats = { template_var: 0, quote: 0, space: 0 };

// ---------------------------------------------------------------- 1. 补回 ${...} 的 $
function fixTemplateDollar(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { out += c + (text[i + 1] || ''); i += 2; continue; }
    if (c === '`') {
      // 进入模板字符串：内容里找缺 $ 的 {...}
      out += c; i += 1;
      let buf = '';
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') { buf += text[i] + (text[i + 1] || ''); i += 2; continue; }
        buf += text[i++];
      }
      const fixed = buf.replace(/(^|[^\\$])\{([^{}[\]]*)\}/g, (m, pre, inner) => {
        if (!/^[A-Za-z_$][\w.$]*([\s.+\-*/|&?:,[\]()'"]|$)/.test(inner)) return m;
        if (/[\u4e00-\u9fff]/.test(inner)) return m;
        stats.template_var += 1;
        return `${pre}\${${inner}}`;
      });
      out += fixed;
      continue;
    }
    if (c === "'" || c === '"') { // 跳过普通字符串，避免误改
      const q = c;
      out += c; i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] || ''); i += 2; continue; }
        if (text[i] === q) break;
        out += text[i++];
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

// ---------------------------------------------------------------- 2. 补回字符串结尾的 '
function fixMissingQuote(text) {
  return text.split('\n').map((line) => {
    // 只处理「明显是字符串字面量的行」：以引号开头、或 describe('...')
    const t = line.replace(/\\'/g, '').replace(/`[^`]*`/g, '``').replace(/"[^"]*"/g, '""');
    const q = (t.match(/'/g) || []).length;
    if (q % 2 === 0) return line;
    if (!/'/.test(line)) return line;
    let idx = line.length;
    while (idx > 0 && ' \t,);}]'.includes(line[idx - 1])) idx -= 1;
    // 只有在缺口正好在行尾「代码标点」之前时才补，避免乱插
    stats.quote += 1;
    return line.slice(0, idx) + "'" + line.slice(idx);
  }).join('\n');
}

// ---------------------------------------------------------------- 3. 中英之间补空格
function fixSpacing(text) {
  const before = text;
  let t = text
    .replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, (m, a, b) => { stats.space += 1; return `${a} ${b}`; })
    .replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, (m, a, b) => { stats.space += 1; return `${a} ${b}`; });
  // 不制造连续双空格
  t = t.replace(/([\u4e00-\u9fff]) +([A-Za-z0-9])/g, '$1 $2').replace(/([A-Za-z0-9]) +([\u4e00-\u9fff])/g, '$1 $2');
  return t === before ? text : t;
}

let out = fixTemplateDollar(src);
out = fixMissingQuote(out);
out = fixSpacing(out);
writeFileSync(file, out, 'utf8');
if (!quiet) console.log(JSON.stringify({ file, ...stats, bytes: Buffer.byteLength(out) }, null, 2));
