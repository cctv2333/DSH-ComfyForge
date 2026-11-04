// test/triage.mjs — 验证「淘汰有依据、移动不删除、可恢复」
// node test/triage.mjs
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OUTPUT_DIR } from '../lib/config.mjs';
import { pythonPath } from '../lib/img.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// 测试底图从本机产物里现找一个（分发包不该依赖某台机器的固定路径）
function findSample() {
  if (!OUTPUT_DIR || !existsSync(OUTPUT_DIR)) return null;
  const walk = (dir, depth = 0) => {
    if (depth > 2) return null;
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of names) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { const hit = walk(p, depth + 1); if (hit) return hit; }
      else if (/\.(png|jpe?g)$/i.test(e.name)) return p;
    }
    return null;
  };
  return walk(OUTPUT_DIR);
}

const SRC = findSample();
const PY = pythonPath();
const DIR = join(HERE, '..', '..', '.cache', 'triage-test');

if (!SRC) { console.error('产物目录里没有可用图片：先跑一张再测淘汰逻辑（或设 COMFY_OUTPUT_DIR）'); process.exit(2); }
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
copyFileSync(SRC, join(DIR, 'good.png'));
copyFileSync(SRC, join(DIR, 'dup.png'));
const py = `from PIL import Image, ImageFilter
im = Image.open(r'${SRC.replace(/\\/g, '\\\\')}')
im.filter(ImageFilter.GaussianBlur(6)).save(r'${join(DIR, 'blur.png').replace(/\\/g, '\\\\')}')
Image.new('RGB', (1024, 1024), (0, 0, 0)).save(r'${join(DIR, 'black.png').replace(/\\/g, '\\\\')}')
im.resize((200, 200)).save(r'${join(DIR, 'tiny.png').replace(/\\/g, '\\\\')}')
`;
const r = spawnSync(PY, ['-c', py], { encoding: 'utf8' });
if (r.status !== 0) { console.error('造测试图失败：' + (r.stderr || '').slice(0, 300)); process.exit(2); }

const t = new StdioClientTransport({ command: process.execPath, args: [join(HERE, '..', 'server.mjs')], stderr: 'pipe' });
const c = new Client({ name: 'triage-test', version: '1' });
await c.connect(t);
const call = async (name, args) => JSON.parse((await c.callTool({ name, arguments: args })).content.find((x) => x.type === 'text').text);

let fail = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + extra}`); if (!cond) fail++; };

const scan = await call('comfy_triage', { dir: DIR, action: 'scan' });
const rejected = Object.fromEntries((scan.rejected || []).map((x) => [x.file, x.reasons.join(';')]));
ok('黑图被判为 near-blank', /near-blank|blurry/.test(rejected['black.png'] || ''), JSON.stringify(rejected));
ok('死糊图被判为 blurry', /blurry/.test(rejected['blur.png'] || ''));
ok('过小图被判为 too small', /too small/.test(rejected['tiny.png'] || ''));
ok('重复图被识别（只淘汰其中一张）', Object.keys(rejected).filter((f) => /duplicate/.test(rejected[f])).length === 1, JSON.stringify(rejected));
ok('保留了一张正常图', (scan.kept || []).length === 1, JSON.stringify(scan.kept));

const ap = await call('comfy_triage', { dir: DIR, action: 'apply' });
ok('执行时移动了 4 张', ap.moved === 4, JSON.stringify(ap).slice(0, 200));
ok('移动到 _trash 而不是删除', !!ap.trash && existsSync(ap.trash) && readdirSync(ap.trash).includes('manifest.json'));
ok('原目录只剩 1 张', readdirSync(DIR).filter((f) => f.endsWith('.png')).length === 1);

const rs = await call('comfy_triage', { dir: DIR, action: 'restore' });
ok('restore 全部搬回', rs.restored === 4, JSON.stringify(rs));
ok('恢复后 5 张齐全', readdirSync(DIR).filter((f) => f.endsWith('.png')).length === 5);

await c.close();
rmSync(DIR, { recursive: true, force: true });
console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
