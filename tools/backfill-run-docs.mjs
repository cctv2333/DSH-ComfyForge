// tools/backfill-run-docs.mjs — 给历史运行记录补 Markdown（让「之前做过什么」可读、可复盘）
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../mcp/lib/config.mjs';
import { runToMarkdown } from '../mcp/lib/templates.mjs';

const dir = join(PROJECT_ROOT, 'runs');
if (!existsSync(dir)) { console.log('没有 runs/ 目录'); process.exit(0); }

let made = 0, skipped = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const src = join(dir, f);
  const md = src.replace(/\.json$/, '.md');
  if (existsSync(md)) { skipped += 1; continue; }
  try {
    const r = JSON.parse(readFileSync(src, 'utf8'));
    writeFileSync(md, runToMarkdown(r), 'utf8');
    made += 1;
  } catch { skipped += 1; }
}
console.log(JSON.stringify({ 新增: made, 跳过: skipped }));
