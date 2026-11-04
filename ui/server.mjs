// ui/server.mjs — 本地看板：把 runs/ + 输出图 + 精选清单 变成一个网页
// 只监听 127.0.0.1；图片只允许读 ComfyUI 输出目录内的文件。
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const RUNS = join(ROOT, 'runs');
// 产物目录与 MCP 共用同一份配置解析（env > comfyforge.config.json > 自动探测），不再写死路径
const { OUTPUT_DIR } = await import('../mcp/lib/config.mjs');
const OUTPUT = OUTPUT_DIR || '';
if (!OUTPUT) {
  console.error('[看板] 没找到 ComfyUI 输出目录。设 COMFY_OUTPUT_DIR 或 COMFY_ROOT，或写 comfyforge.config.json。\n' +
    '  自查：node mcp/doctor.mjs');
}
const PICKS = join(ROOT, 'picks.json');
const PORT = Number(process.env.DASHBOARD_PORT || 8790);
const HOST = '127.0.0.1';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function readPicks() {
  if (!existsSync(PICKS)) return {};
  try { return JSON.parse(readFileSync(PICKS, 'utf8')).items || {}; } catch { return {}; }
}
function writePicks(items) {
  writeFileSync(PICKS, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
}

function relOf(p) {
  const r = String(p || '').replace(/\\/g, '/');
  const base = OUTPUT.replace(/\\/g, '/');
  return r.startsWith(base) ? r.slice(base.length + 1) : null;
}

function scanRuns(limit = 60) {
  if (!existsSync(RUNS)) return [];
  const picks = readPicks();
  return readdirSync(RUNS)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .flatMap((f) => {
      try {
        const r = JSON.parse(readFileSync(join(RUNS, f), 'utf8'));
        const outputs = (r.outputs || []).map((o) => {
          const rel = relOf(o.path) || (o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename);
          const key = o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename;
          const exists = existsSync(join(OUTPUT, rel));
          return {
            key, filename: o.filename, subfolder: o.subfolder || '',
            url: exists ? `/img?p=${encodeURIComponent(rel)}` : null,
            width: o.quality?.width ?? o.width, height: o.quality?.height ?? o.height,
            bytes: o.bytes, quality: o.quality || null,
            picked: !!picks[key],
          };
        });
        return [{
          file: f, prompt_id: r.prompt_id, status: r.status, template: r.template,
          params: r.params || {}, at: r.saved_at, outputs,
          error: r.error || null,
        }];
      } catch { return []; }
    });
}

/** 直接扫输出目录：没进 runs/ 的图也不能在看板里消失 */
function scanOutputImages(limit = 60) {
  const out = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      if (!MIME[extname(name).toLowerCase()]) continue;
      const rel = p.replace(/\\/g, '/').slice(OUTPUT.replace(/\\/g, '/').length + 1);
      const sub = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      out.push({
        key: sub ? `${sub}/${name}` : name,
        filename: name, subfolder: sub, mtime: st.mtimeMs, bytes: st.size,
        url: `/img?p=${encodeURIComponent(rel)}`,
      });
    }
  };
  walk(OUTPUT);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

// —— 和 ComfyUI 说话（只读，用于展示真实执行图/节点名）——
const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188';
let _infoCache = null;
let _infoAt = 0;
async function comfyJson(path, timeout = 20000) {
  const r = await fetch(COMFY + path, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`ComfyUI ${path} -> HTTP ${r.status}`);
  return r.json();
}
async function objectInfoCached() {
  if (_infoCache && Date.now() - _infoAt < 300000) return _infoCache;
  try {
    _infoCache = await comfyJson('/object_info', 60000);
    _infoAt = Date.now();
  } catch {
    _infoCache = _infoCache || {};
  }
  return _infoCache;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(readFileSync(join(HERE, 'index.html')));
  }

  if (p === '/flow' || p === '/flow.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(readFileSync(join(HERE, 'flow.html')));
  }

  // 工作流图：默认取 ComfyUI 最近一次真实执行的图（history.prompt），也可回退到模板
  if (p === '/api/graph') {
    const source = url.searchParams.get('source') || 'history';
    const tplName = url.searchParams.get('template') || 'flux_t2i';
    let wf = null, title = '', description = '', name = tplName, bindings = {}, defaults = {}, ranAt = null;

    if (source === 'template') {
      const file = join(ROOT, 'workflows', `${tplName}.json`);
      if (!/^[\w.-]+$/.test(tplName) || !existsSync(file)) return sendJson(res, 404, { ok: false, error: `模板 ${tplName} 不存在` });
      const tpl = JSON.parse(readFileSync(file, 'utf8'));
      wf = tpl.workflow || {};
      title = tpl.title || ''; description = tpl.description || '';
      bindings = tpl.bindings || {}; defaults = tpl.defaults || {};
    } else {
      const h = await comfyJson('/history?max_items=40');
      const ids = Object.keys(h || {});
      for (const id of ids.reverse()) {
        const e = h[id];
        const g = e?.prompt?.[2];
        if (!g || e?.status?.status_str !== 'success') continue;
        wf = g; name = id.slice(0, 8);
        title = `最近一次实际执行 · ${name}`;
        ranAt = e?.prompt?.[3]?.create_time || null;
        break;
      }
      if (!wf) return sendJson(res, 404, { ok: false, error: '还没有可展示的历史执行' });
    }

    const info = await objectInfoCached();
    const nodes = Object.entries(wf).map(([id, n]) => ({
      id,
      class_type: n.class_type,
      display_name: info?.[n.class_type]?.display_name || n.class_type,
      category: info?.[n.class_type]?.category || '',
      inputs: n.inputs || {},
    }));
    const edges = [];
    for (const [id, n] of Object.entries(wf)) {
      for (const [input, v] of Object.entries(n.inputs || {})) {
        if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string') edges.push({ from: v[0], to: id, input });
      }
    }
    return sendJson(res, 200, { ok: true, source, name, title, description, ranAt, bindings, defaults, nodes, edges });
  }

  if (p === '/api/state') {
    const runs = scanRuns();
    const picks = readPicks();
    const seen = new Set(runs.flatMap((r) => (r.outputs || []).map((o) => o.key)));
    const orphans = scanOutputImages().filter((o) => !seen.has(o.key));
    if (orphans.length) {
      runs.push({
        file: '(orphans)', prompt_id: '', status: 'success', template: '(未归档)',
        params: {}, at: new Date(Math.max(...orphans.map((o) => o.mtime))).toISOString(),
        outputs: orphans.map((o) => ({ ...o, quality: null, picked: !!picks[o.key] })),
      });
    }
    runs.sort((a, b) => String(b.at).localeCompare(String(a.at)));

    // 同一个模板 + 同一提示词 + 同一尺寸 = 一个批次，看板里合成一张卡，便于横向对比
    const groups = new Map();
    for (const r of runs) {
      const p = r.params || {};
      const key = [r.template || '', p.prompt || '', p.width || '', p.height || '', p.steps || ''].join('|');
      if (!groups.has(key)) {
        groups.set(key, { ...r, outputs: [...r.outputs] });
      } else {
        const g = groups.get(key);
        const seen = new Set(g.outputs.map((o) => o.key));
        for (const o of r.outputs) if (!seen.has(o.key)) { g.outputs.push(o); seen.add(o.key); }
        if (String(r.at) > String(g.at)) g.at = r.at;
      }
    }
    const grouped = [...groups.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    for (const g of grouped) g.outputs.sort((a, b) => String(a.filename).localeCompare(String(b.filename)));

    const images = grouped.flatMap((r) => r.outputs.map((o) => ({ ...o, prompt_id: r.prompt_id, at: r.at, template: r.template, params: r.params })));
    return sendJson(res, 200, {
      ok: true,
      output_dir: OUTPUT,
      counts: {
        runs: grouped.length,
        images: images.length,
        picked: Object.keys(picks).length,
        flagged: images.filter((i) => i.quality && (i.quality.verdict?.level || 'ok') !== 'ok').length,
      },
      runs: grouped.map((r) => ({ ...r, outputs: r.outputs.map((o) => ({ ...o, picked: !!picks[o.key] })) })),
      picks: Object.values(picks),
    });
  }

  if (p === '/api/pick' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try {
        const { filename, subfolder = '', prompt_id, note = '', quality } = JSON.parse(body || '{}');
        if (!filename) return sendJson(res, 400, { ok: false, error: 'filename required' });
        const items = readPicks();
        const key = subfolder ? `${subfolder}/${filename}` : filename;
        items[key] = { key, filename, subfolder, prompt_id, note, quality, by: 'user', picked_at: new Date().toISOString() };
        writePicks(items);
        sendJson(res, 200, { ok: true, key, count: Object.keys(items).length });
      } catch (e) { sendJson(res, 500, { ok: false, error: e.message }); }
    });
    return;
  }

  if (p === '/api/unpick' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try {
        const { key } = JSON.parse(body || '{}');
        const items = readPicks();
        delete items[key];
        writePicks(items);
        sendJson(res, 200, { ok: true, count: Object.keys(items).length });
      } catch (e) { sendJson(res, 500, { ok: false, error: e.message }); }
    });
    return;
  }

  if (p === '/img') {
    const rel = url.searchParams.get('p') || '';
    const target = normalize(join(OUTPUT, rel));
    if (!target.startsWith(normalize(OUTPUT))) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    if (!existsSync(target) || !statSync(target).isFile()) return sendJson(res, 404, { ok: false, error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream', 'cache-control': 'max-age=60' });
    return createReadStream(target).pipe(res);
  }

  sendJson(res, 404, { ok: false, error: 'not found', path: p });
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`ComfyForge dashboard: ${url}  (output=${OUTPUT})`);
  // 默认不弹外部浏览器（用户要的是在 DSH 里看）。需要弹出时设 DASHBOARD_OPEN=1。
  if (process.env.DASHBOARD_OPEN === '1') {
    try {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch { /* 打不开也不影响服务 */ }
  }
});
