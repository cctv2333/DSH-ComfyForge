// 00-store.js — 数据层：HTTP + SSE，只负责把后端状态变成 React 可订阅的快照。
// 这一层不认识任何 DOM/样式；换 UI 不用改这里。

const API = '/comfy-live'
const PANEL_ID = 'comfy-live'

const listeners = new Set()
let snap = {
  v: 0,
  ready: false,
  connected: false,
  comfyUrl: '',
  runs: [],
  liveId: null,
  selectedId: null,
  following: true,
  saved: null,
  details: {},
  error: null,
  queue: null,
  tab: 'runs',
  library: null,
  workflows: null,
  wfPreview: null,
}

function set(patch) {
  snap = { ...snap, ...patch, v: snap.v + 1 }
  for (const fn of listeners) { try { fn() } catch { /* ignore */ } }
}
function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }
function getSnapshot() { return snap }

function useStore() {
  if (typeof React.useSyncExternalStore === 'function') {
    return React.useSyncExternalStore(subscribe, getSnapshot)
  }
  const [state, setState] = useState(getSnapshot)
  useEffect(() => subscribe(() => setState(getSnapshot())), [])
  return state
}

let stream = null
let booted = false
const pendingDetail = new Set()

async function refresh() {
  try {
    const r = await fetch(`${API}/api/state`, { cache: 'no-store' })
    const j = await r.json()
    if (!j.ok) throw new Error(j.error || 'state 读取失败')
    const runs = Array.isArray(j.runs) ? j.runs : []
    set({
      ready: true,
      connected: !!j.connected,
      comfyUrl: j.comfyUrl || '',
      runs,
      liveId: j.live || null,
      saved: j.saved || null,
      error: null,
    })
    if (snap.following || !snap.selectedId) {
      const target = j.live || (runs[0] && runs[0].id)
      if (target) select(target, true)
    }
  } catch (e) {
    set({ ready: true, error: String(e && e.message ? e.message : e) })
  }
}

function select(id, silent) {
  if (!id) return
  if (!silent) set({ selectedId: id, following: false })
  else if (snap.selectedId !== id) set({ selectedId: id })
  ensureDetail(id)
}

async function ensureDetail(id, attempt) {
  if (!id) return
  const cur = snap.details[id]
  if (cur && cur.graph) return
  if (pendingDetail.has(id)) return
  pendingDetail.add(id)
  try {
    const r = await fetch(`${API}/api/run?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
    const j = await r.json()
    if (j.ok && j.run) {
      const details = { ...snap.details, [id]: { ...(snap.details[id] || {}), ...j.run } }
      set({ details })
    }
  } catch { /* 图还没就绪 */ } finally {
    pendingDetail.delete(id)
  }
  const after = snap.details[id]
  const tries = (attempt || 0) + 1
  if (!after || !after.graph) {
    if (tries < 20) setTimeout(() => ensureDetail(id, tries), 900)
  }
}

function mergeRun(id, patch) {
  set({ runs: snap.runs.map((r) => (r.id === id ? { ...r, ...patch } : r)) })
}

function mergeDetail(id, patch) {
  const details = { ...snap.details, [id]: { ...(snap.details[id] || {}), ...patch } }
  set({ details })
}

function handleEvent(ev) {
  if (!ev || !ev.t) return
  if (ev.t === 'conn') { set({ connected: !!ev.connected }); return }
  if (ev.t === 'queue') { set({ queue: ev.remaining }); return }
  if (ev.t === 'run:new') {
    const run = ev.run
    if (!run) return
    const existed = snap.runs.some((r) => r.id === run.id)
    set({ runs: [run, ...snap.runs.filter((r) => r.id !== run.id)] })
    // 只有"真在跑"的才抢选中：历史补录（source=history）不能把用户正在看的切走
    const isLive = run.status === 'running' || run.source === 'live'
    if (!existed && isLive && snap.following) select(run.id, true)
    if (isLive) ensureDetail(run.id)
    return
  }
  if (ev.t === 'run:summary') { mergeRun(ev.run.id, ev.run); return }
  if (ev.t === 'run:graph') {
    mergeDetail(ev.id, { graph: ev.graph })
    mergeRun(ev.id, { label: ev.label })
    return
  }
  if (ev.t === 'nodes') {
    mergeDetail(ev.id, { nodeStates: ev.states, currentNode: ev.current || null })
    if (ev.current) mergeRun(ev.id, { currentNode: ev.current })
    return
  }
  if (ev.t === 'progress') {
    mergeDetail(ev.id, { progress: ev.progress })
    mergeRun(ev.id, { progress: ev.progress })
    return
  }
  if (ev.t === 'preview') { mergeDetail(ev.id, { preview: ev.data }); return }
  if (ev.t === 'output') {
    const detail = snap.details[ev.id] || {}
    const outs = [...(detail.outputs || []), ev.output]
    mergeDetail(ev.id, { outputs: outs })
    const run = snap.runs.find((r) => r.id === ev.id)
    mergeRun(ev.id, { outputs: outs.length, thumb: (run && run.thumb) || ev.output.url })
    return
  }
  if (ev.t === 'run:end') {
    mergeRun(ev.id, ev.run)
    mergeDetail(ev.id, {
      status: ev.run.status,
      endedAt: ev.run.endedAt,
      error: ev.run.error,
      outputs: ev.outputs || (snap.details[ev.id] || {}).outputs || [],
    })
    return
  }
}

function startStream() {
  if (stream) return stream
  try {
    stream = new EventSource(`${API}/api/events`)
    stream.onmessage = (e) => {
      try { handleEvent(JSON.parse(e.data)) } catch { /* ignore */ }
    }
    stream.onerror = () => { /* EventSource 自己重连 */ }
  } catch { /* 浏览器不支持就退回手动刷新 */ }
  return stream
}

function boot() {
  if (booted) return
  booted = true
  startStream()
  refresh()
  setInterval(() => { if (!snap.ready) refresh() }, 4000)
}

// ---- 工作台：产物库 / 工作流库（按需加载，加载过就不再重复请求）

async function loadLibrary(force) {
  if (!force && snap.library) return
  try {
    const r = await fetch(`${API}/api/library?limit=400`, { cache: 'no-store' })
    const j = await r.json()
    set({ library: j && j.ok ? j : { ok: false, items: [], error: (j && j.error) || '读取失败' } })
  } catch (e) {
    set({ library: { ok: false, items: [], error: String(e.message || e) } })
  }
}

async function loadWorkflows(force) {
  if (!force && snap.workflows) return
  try {
    const r = await fetch(`${API}/api/workflows`, { cache: 'no-store' })
    const j = await r.json()
    set({ workflows: j && j.ok ? j : { ok: false, items: [], error: (j && j.error) || '读取失败' } })
  } catch (e) {
    set({ workflows: { ok: false, items: [], error: String(e.message || e) } })
  }
}

async function openWorkflow(name) {
  try {
    const r = await fetch(`${API}/api/workflow?name=${encodeURIComponent(name)}`, { cache: 'no-store' })
    const j = await r.json()
    if (j && j.ok) set({ wfPreview: j })
  } catch { /* 打不开就算了，别把面板弄崩 */ }
}
