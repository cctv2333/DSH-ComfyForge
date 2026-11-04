// tools/backfill-batch.mjs — 给「跨多次调用才完成」的批次补运行记录
// 用法：node tools/backfill-batch.mjs --dir cyber --prefix scene --w 1344 --h 768 --steps 20 --prompt "..."
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { metrics } from '../mcp/lib/img.mjs';
import { saveRun } from '../mcp/lib/templates.mjs';
import { OUTPUT_DIR } from '../mcp/lib/config.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const dirName = arg('dir', '');
const width = Number(arg('w', '1344'));
const height = Number(arg('h', '768'));
const steps = Number(arg('steps', '20'));
const prompt = arg('prompt', '');
if (!OUTPUT_DIR) {
  console.error('不知道 ComfyUI 产物目录：设 COMFY_ROOT 或 COMFY_OUTPUT_DIR');
  process.exit(2);
}
const dir = join(OUTPUT_DIR, dirName);

const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
const ms = metrics(files.map((f) => join(dir, f)));
files.forEach((f, i) => {
  const m = ms[i];
  saveRun({
    prompt_id: `backfill-${dirName}-${f.replace('.png', '')}`,
    status: 'success', template: 'flux_t2i',
    params: { prompt, width, height, steps },
    outputs: [{
      filename: f, subfolder: dirName, path: join(dir, f), bytes: statSync(join(dir, f)).size,
      width: m.width, height: m.height,
      quality: { width: m.width, height: m.height, megapixels: m.megapixels, lap_var_512: m.lap_var_512, edge_pct: m.edge_pct, contrast: m.contrast, clip_high: m.clip_high, clip_low: m.clip_low, verdict: m.verdict },
    }],
  });
});
console.log(JSON.stringify({ dir: dirName, count: files.length, files }));
