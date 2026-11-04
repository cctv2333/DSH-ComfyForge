// lib/comfy.mjs — ComfyUI HTTP 客户端（带超时、错误定位、object_info 缓存）
//
// 所有路径/地址都来自 lib/config.mjs（env > 配置文件 > 自动探测），这里不再出现
// 任何一台机器的绝对路径——分发出去才能跑。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  BASE, POLL_MS, NOT_QUEUED_GRACE_MS, COMFY_ROOT, OUTPUT_DIR, LOG_PATH,
  PROJECT_ROOT, CACHE_DIR, WORKFLOW_DIR, RUNS_DIR, MODE,
} from './config.mjs';

export {
  BASE, POLL_MS, NOT_QUEUED_GRACE_MS, COMFY_ROOT, OUTPUT_DIR, LOG_PATH,
  PROJECT_ROOT, CACHE_DIR, WORKFLOW_DIR, RUNS_DIR, MODE,
};

export class ComfyError extends Error {
  constructor(message, { status, body, kind } = {}) {
    super(message);
    this.name = 'ComfyError';
    this.status = status;
    this.body = body;
    this.kind = kind; // connect | http | submit | execution | timeout
  }
}

async function request(path, { method = 'GET', body, timeout = 30_000 } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new ComfyError(
      `连不上 ComfyUI（${BASE}）：${e.name === 'TimeoutError' ? '请求超时' : e.message}。请确认 ComfyUI 已启动且端口 8188 在监听。`,
      { kind: 'connect' },
    );
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    throw new ComfyError(`HTTP ${res.status} ${path}：${truncate(text, 800)}`, {
      status: res.status, body: json ?? text, kind: 'http',
    });
  }
  // 有些接口（/view）返回二进制，调用方自己处理
  return json ?? text;
}

export const get = (path, timeout) => request(path, { timeout });
export const post = (path, body, timeout) => request(path, { method: 'POST', body, timeout });

function truncate(s, n) { return typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s; }

export async function systemStats() { return get('/system_stats', 10_000); }
export async function queueState() { return get('/queue', 10_000); }
export async function history(id) { return get('/history/' + encodeURIComponent(id), 15_000); }
export async function recentHistory(maxItems = 32) { return get(`/history?max_items=${maxItems}`, 20_000); }

/**
 * 支持「短 id」：界面上常只看到 8 位前缀，直接拿去查 /history/{id} 会查空。
 * 精确查不到时退到最近历史里做前缀匹配（命中唯一一个才算数）。
 */
export async function historyResolved(id) {
  const h = await history(id);
  if (h?.[id]) return { entry: h[id], id };
  const all = await recentHistory(32);
  const hits = Object.keys(all || {}).filter((k) => k.startsWith(id));
  if (hits.length === 1) return { entry: all[hits[0]], id: hits[0] };
  return { entry: null, id };
}

let _infoCache = null;
let _infoAt = 0;
export async function objectInfo({ maxAgeMs = 120_000 } = {}) {
  if (_infoCache && Date.now() - _infoAt < maxAgeMs) return _infoCache;
  _infoCache = await get('/object_info', 90_000);
  _infoAt = Date.now();
  return _infoCache;
}

export function invalidateObjectInfo() { _infoCache = null; _infoAt = 0; }

/** 把 /prompt 的 400 响应翻译成人看得懂的诊断 */
export function explainPromptError(payload, status) {
  const lines = [];
  const err = payload?.error;
  if (err) lines.push(`ComfyUI 拒绝了这个工作流：${err.message || err.type || JSON.stringify(err)}`);
  const nodeErrors = payload?.node_errors || {};
  for (const [nodeId, ne] of Object.entries(nodeErrors)) {
    const cls = ne.class_type ? `${ne.class_type}` : '?';
    for (const e of ne.errors || []) {
      lines.push(`  节点 ${nodeId} (${cls}): ${e.message}${e.details ? ` — ${e.details}` : ''}`);
    }
  }
  if (!lines.length) lines.push(`提交失败（HTTP ${status}）：${truncate(JSON.stringify(payload), 500)}`);
  return lines.join('\n');
}

/**
 * 实时台通道。
 *
 * 为什么提交要绕一圈：ComfyUI 只把 execution_start / executing / progress /
 * execated 和预览帧发给「提交时的那个 client_id」的 socket。旁听者一条都收不到。
 * 所以 DSH 的 Comfy 实时台插件用自己的 client_id 代提交，节点级进度才会回到面板。
 * 插件把它的 origin 写进 .cache/comfy-live-endpoint.json；读不到就退回直连。
 */
function liveOrigin() {
  if (process.env.COMFYFORGE_LIVE === '0') return null;
  try {
    const p = join(CACHE_DIR, 'comfy-live-endpoint.json');
    const st = statSync(p);
    if (Date.now() - st.mtimeMs > 12 * 3600_000) return null;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const origin = typeof j?.origin === 'string' ? j.origin.replace(/\/$/, '') : '';
    return /^https?:\/\/[^\s]+$/.test(origin) ? origin : null;
  } catch { return null; }
}

async function submitViaLive(origin, workflow) {
  const res = await fetch(`${origin}/comfy-live/api/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok || !json?.prompt_id) {
    const err = json?.error;
    if (res.status === 404 || res.status === 405 || err?.type === 'method' || err?.type === 'no_prompt') {
      // 面板没装 / 路由不在：交给直连
      return null;
    }
    throw new ComfyError(explainPromptError(json, res.status), {
      status: res.status, body: json ?? text, kind: 'submit',
    });
  }
  return json;
}

export async function submit(workflow, { clientId, live = true } = {}) {
  if (live) {
    const origin = liveOrigin();
    if (origin) {
      try {
        const via = await submitViaLive(origin, workflow);
        if (via) return via;
      } catch (e) {
        if (e instanceof ComfyError) throw e; // 工作流本身不合法：别用直连掩盖
        // 面板挂了/没响应：退回直连，任务照样能跑
      }
    }
  }
  const payload = { prompt: workflow };
  if (clientId) payload.client_id = clientId;
  let res;
  try {
    res = await fetch(BASE + '/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new ComfyError(`提交失败（连不上 ${BASE}）：${e.message}`, { kind: 'connect' });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok || !json?.prompt_id) {
    throw new ComfyError(explainPromptError(json, res.status), {
      status: res.status, body: json ?? text, kind: 'submit',
    });
  }
  return json;
}

/** 从 history 条目里抽出产物与状态 */
export function parseHistoryEntry(entry) {
  const st = entry?.status || {};
  const images = [];
  const other = [];
  for (const [nodeId, out] of Object.entries(entry?.outputs || {})) {
    for (const img of out?.images || []) {
      images.push({ node: nodeId, filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
    }
    for (const key of ['gifs', 'videos', 'audio', 'text']) {
      if (Array.isArray(out?.[key])) other.push({ node: nodeId, kind: key, items: out[key] });
    }
  }
  const errors = [];
  for (const m of st.messages || []) {
    const [kind, data] = m;
    if (kind === 'execution_error') {
      errors.push({
        node_id: data.node_id,
        node_type: data.node_type,
        exception_type: data.exception_type,
        exception_message: data.exception_message,
        traceback: (data.traceback || []).slice(-6),
      });
    } else if (kind === 'execution_interrupted') {
      errors.push({ interrupted: true });
    }
  }
  return {
    status: st.status_str || 'unknown',
    completed: !!st.completed,
    images,
    other,
    errors,
  };
}

/**
 * 等一个 prompt 完成。
 * 关键：不抛「超时」异常，而是返回 { pending: true } —— 因为 MCP 客户端（含 DSH）
 * 对单次工具调用通常只有 ~60s 的超时，服务器端必须主动把长任务切成「一次等一小段」，
 * 由 agent 反复调用。v0.1 的 300s 阻塞等待在这种客户端下必然表现为「调用失败」。
 */
export async function waitFor(promptId, { timeoutS = 45, pollMs = POLL_MS } = {}) {
  const t0 = Date.now();
  const limit = timeoutS * 1000;
  let sawQueued = false;
  for (;;) {
    const { entry } = await historyResolved(promptId);
    if (entry?.status?.status_str) return { entry, elapsedMs: Date.now() - t0, pending: false };

    if (!sawQueued) {
      const q = await queueState();
      sawQueued = [...(q.queue_running || []), ...(q.queue_pending || [])].some((x) => x[1] === promptId);
    }
    const now = Date.now() - t0;
    if (!sawQueued && now > NOT_QUEUED_GRACE_MS) {
      throw new ComfyError(
        `prompt_id ${promptId} 既不在队列里也不在 history 里——可能被 ComfyUI 重启清空，或 id 写错了。`,
        { kind: 'timeout' },
      );
    }
    if (now > limit) {
      const q = await queueState();
      const idx = (q.queue_pending || []).findIndex((x) => x[1] === promptId);
      return {
        pending: true,
        elapsedMs: now,
        queue: {
          running: (q.queue_running || []).length,
          pending: (q.queue_pending || []).length,
          position: idx >= 0 ? idx + 1 : 0,
        },
      };
    }
    await sleep(pollMs);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function viewBytes({ filename, subfolder = '', type = 'output' }) {
  const qs = new URLSearchParams({ filename, subfolder, type });
  const res = await fetch(`${BASE}/view?${qs}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new ComfyError(`取图失败 ${filename} (subfolder="${subfolder}", type=${type}) → HTTP ${res.status}。` +
      `若文件名里带目录，请拆成 filename + subfolder 两个参数。`, { status: res.status, kind: 'http' });
  }
  return { buf: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'image/png' };
}

export async function interrupt() { return post('/interrupt', {}, 10_000); }
export async function deleteFromQueue(ids) { return post('/queue', { delete: ids }, 10_000); }

/** 本地产物路径（同机时最快），不存在则 null —— 远程模式下恒为 null，调用方回退到 /view 下载 */
export function localOutputPath({ filename, subfolder = '', type = 'output' }) {
  if (!COMFY_ROOT && type !== 'output') return null;
  const base = type === 'output'
    ? OUTPUT_DIR
    : type === 'temp'
      ? (COMFY_ROOT ? join(COMFY_ROOT, 'temp') : null)
      : (COMFY_ROOT ? join(COMFY_ROOT, 'input') : null);
  if (!base) return null;
  const p = join(base, subfolder, filename);
  return existsSync(p) ? p : null;
}
