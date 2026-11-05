// lib/triage.mjs — 有依据的淘汰：只按「客观缺陷」判定，移动而不是删除，可一键恢复
//
// 设计原则（回应「谁知道哪张好？万一乱删」）：
//   1. 只淘汰客观缺陷（读不出、接近纯色、死糊、过小、重复），不做审美判断；
//   2. 不删除，移动到 <dir>/_trash/<时间戳>/，并写 manifest.json 记录原因；
//   3. picks.json 里的图永不移动；
//   4. 可 restore 一键搬回。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { OUTPUT_DIR, PROJECT_ROOT } from './comfy.mjs';
import { metrics } from './img.mjs';
import { readPicks } from './picks.mjs';
import { probeDuration } from './video.mjs';

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VID_EXT = new Set(['.mp4', '.webm', '.mkv', '.mov']);

const RULES = {
  minSide: 256,       // 小于这个边长视为「太小」
  flatContrast: 0.02, // 灰度标准差低于此 → 近似纯色
  flatEntropy: 3.0,   // 直方图熵低于此 → 无内容
  blurLap512: 5.0,    // 归一化锐度低于此 → 死糊
  dupDistance: 2,     // 均值哈希汉明距离 <= 此值视为重复
  // 视频：没有"锐度/纯色"这种便宜判据，只判硬缺陷（大小、时长、读不出）
  minBytes: 100 * 1024,
  minSeconds: 0.8,
};

function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
}

export function resolveDir(dir) {
  if (!dir) {
    if (!OUTPUT_DIR) throw new Error('不知道产物目录：设 COMFY_ROOT 或 COMFY_OUTPUT_DIR，或跑 node mcp/doctor.mjs 自查');
    return OUTPUT_DIR;
  }
  const absolute = dir.includes(':\\') || dir.startsWith('/') || dir.startsWith('\\\\');
  if (absolute) return dir;
  if (!OUTPUT_DIR) throw new Error(`相对路径 ${dir} 需要先知道产物目录：设 COMFY_ROOT 或 COMFY_OUTPUT_DIR`);
  return join(OUTPUT_DIR, dir);
}

const extOf = (f) => f.slice(f.lastIndexOf('.')).toLowerCase();
const isVideo = (f) => VID_EXT.has(extOf(f));

/** 列出目录下所有可淘汰的媒体文件（图片 + 视频） */
function listMedia(dir) {
  if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`);
  return readdirSync(dir)
    .filter((f) => IMG_EXT.has(extOf(f)) || VID_EXT.has(extOf(f)))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile());
}

/** 只读扫描：给出「建议淘汰」和「建议保留」，不改动任何文件 */
export function scan(dir) {
  const files = listMedia(dir);
  const rows = [];
  for (const p of files) {
    const kind = isVideo(p) ? 'video' : 'image';
    if (kind === 'video') {
      let sizeBytes = 0;
      try { sizeBytes = statSync(p).size; } catch { /* ignore */ }
      let duration = null;
      try { duration = probeDuration(p); } catch { duration = null; }
      rows.push({ path: p, file: basename(p), kind, m: { sizeBytes, duration }, reasons: [] });
      continue;
    }
    try {
      const m = metrics([p])[0];
      rows.push({ path: p, file: basename(p), kind, m, reasons: [] });
    } catch (e) {
      rows.push({ path: p, file: basename(p), kind, m: null, reasons: ['unreadable: ' + e.message.slice(0, 80)] });
    }
  }

  for (const r of rows) {
    if (r.kind === 'video') {
      const m = r.m || {};
      if (!m.sizeBytes) { r.reasons.push('unreadable: 文件为空或读不到'); continue; }
      if (m.sizeBytes < RULES.minBytes) r.reasons.push(`too small (${Math.round(m.sizeBytes / 1024)}KB)`);
      if (m.duration == null) { r.reasons.push('unreadable: 读不出时长（ffmpeg 不在或文件损坏）'); continue; }
      if (m.duration < RULES.minSeconds) r.reasons.push(`too short (${m.duration}s)`);
      continue;
    }
    const m = r.m;
    if (!m) continue;
    if (Math.min(m.width, m.height) < RULES.minSide) r.reasons.push(`too small (${m.width}x${m.height})`);
    if (m.contrast < RULES.flatContrast || m.entropy < RULES.flatEntropy) r.reasons.push(`near-blank (contrast ${m.contrast}, entropy ${m.entropy})`);
    if (m.lap_var_512 < RULES.blurLap512) r.reasons.push(`blurry (lap512 ${m.lap_var_512})`);
  }

  // 重复：保留锐度更高的那张
  const withHash = rows.filter((r) => r.m?.ahash);
  for (let i = 0; i < withHash.length; i++) {
    for (let j = i + 1; j < withHash.length; j++) {
      const a = withHash[i], b = withHash[j];
      if (a.reasons.length || b.reasons.length) continue;
      if (hamming(a.m.ahash, b.m.ahash) <= RULES.dupDistance) {
        const loser = (a.m.lap_var_512 >= b.m.lap_var_512) ? b : a;
        const winner = loser === a ? b : a;
        loser.reasons.push(`duplicate of ${winner.file}`);
      }
    }
  }

  const picks = readPicks().items || {};
  for (const r of rows) {
    const key = `${basename(dir)}/${r.file}`;
    if (picks[key] || picks[r.file]) {
      r.protected = true;
      r.reasons = r.reasons.filter((x) => !x.startsWith('duplicate'));
      if (r.reasons.length) r.reasons.push('(picked: 不会移动，仅提示)');
    }
  }

  const rejected = rows.filter((r) => r.reasons.length);
  const kept = rows.filter((r) => !r.reasons.length);
  return {
    dir, total: rows.length,
    rejected: rejected.map((r) => ({
      file: r.file,
      kind: r.kind,
      reasons: r.reasons,
      protected: !!r.protected,
      metrics: r.kind === 'video'
        ? { duration: r.m?.duration, sizeKB: r.m?.sizeBytes ? Math.round(r.m.sizeBytes / 1024) : null }
        : (r.m ? { w: r.m.width, h: r.m.height, lap512: r.m.lap_var_512, contrast: r.m.contrast } : null),
    })),
    kept: kept.map((r) => r.file),
    rules: RULES,
    note: '视频只判硬缺陷（大小/时长/读不出）；「好不好看」不在本工具的判据里。',
  };
}

/** 执行淘汰：移动到 _trash/<ts>/，写 manifest，不删除 */
export function apply(dir) {
  const plan = scan(dir);
  const movable = plan.rejected.filter((x) => !x.protected);
  if (!movable.length) return { dir, moved: 0, message: '没有需要淘汰的文件（或全被 picks 保护）', trash: null };
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const trash = join(dir, '_trash', ts);
  mkdirSync(trash, { recursive: true });
  const moved = [];
  for (const x of movable) {
    const from = join(dir, x.file);
    const to = join(trash, x.file);
    renameSync(from, to);
    moved.push({ file: x.file, reasons: x.reasons, from, to });
  }
  const manifest = { at: new Date().toISOString(), dir, rules: plan.rules, moved };
  writeFileSync(join(trash, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { dir, moved: moved.length, trash, manifest: join(trash, 'manifest.json'), items: moved };
}

/** 恢复最近一次（或指定）垃圾桶 */
export function restore(dir, trashName) {
  const root = join(dir, '_trash');
  if (!existsSync(root)) return { dir, restored: 0, message: '没有垃圾桶' };
  const batches = readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory()).sort();
  const pick = trashName || batches[batches.length - 1];
  if (!pick) return { dir, restored: 0, message: '垃圾桶是空的' };
  const folder = join(root, pick);
  const manifestPath = join(folder, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`找不到 ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let n = 0;
  for (const item of manifest.moved || []) {
    const from = join(folder, item.file);
    const to = join(dir, item.file);
    if (existsSync(from) && !existsSync(to)) { renameSync(from, to); n++; }
  }
  return { dir, restored: n, batch: pick };
}
