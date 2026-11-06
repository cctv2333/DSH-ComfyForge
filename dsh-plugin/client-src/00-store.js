// 00-store.js — 数据层：HTTP + SSE，只负责把后端状态变成 React 可订阅的快照。
// 这一层不认识任何 DOM/样式；换 UI 不用改这里。

const API = '/comfy-live'
const PANEL_ID = 'comfy-live'

/** apply 里存进来的 ctx：界面需要在「贴右列 / 浮动窗」之间切换时用 */
let UI_CTX = null

/**
 * 界面偏好（入口按钮位置等）存 Host 磁盘，不用 localStorage。
 * 原因：DSH 每次启动端口都会变，浏览器按 origin 隔离存储，换端口 = 新站点 = 空存储。
 * 用 localStorage 记位置，效果就是"每次打开都忘"。
 */
let uiPrefs = null

async function loadUiPrefs() {
  try {
    const r = await fetch(`${API}/api/ui`, { cache: 'no-store' })
    const j = await r.json()
    uiPrefs = j && j.ok ? j : {}
  } catch { uiPrefs = {} }
  return uiPrefs
}

function patchUiPrefs(patch) {
  try {
    fetch(`${API}/api/ui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => { /* ignore */ })
  } catch { /* ignore */ }
}

/**
 * 诊断通道：这台机器上没有 DevTools（DSH 跑在桌面壳里），
 * 所以客户端出问题时唯一能拿到的第一手材料，就是它自己写回 Host 的这行日志。
 * 任何地方都可以调；失败一律吞掉，绝不因为诊断把界面弄崩。
 */
/**
 * 客户端诊断：写回 Host 的 /comfy-live/api/diag，落盘到 <projectRoot>/.cache/client-diag.log。
 *
 * 2026-11-06 加重：换一台机器时 Host 的 projectRoot 可能指向不存在的目录，
 * 于是**这条日志本身也写不进去** —— 用户看到"面板出不来"，而两侧都没有任何痕迹。
 * 现在同时在浏览器内存里留一份环形缓冲，并且第一次写回失败就在控制台喊一声：
 *   打开 DevTools → 控制台 → window.__COMFY_LIVE_DIAG__ 就能看到全部尝试与错误。
 */
const DIAG_BUF = []
let diagPostFailed = false

function diag(tag, data) {
  try {
    const rec = { t: Date.now(), tag, data: data === undefined ? null : data }
    DIAG_BUF.push(rec)
    if (DIAG_BUF.length > 300) DIAG_BUF.shift()
  } catch { /* ignore */ }
  try {
    fetch(`${API}/api/diag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag, data: data === undefined ? null : data }),
      keepalive: true,
    }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
    }).catch((e) => {
      if (diagPostFailed) return
      diagPostFailed = true
      try {
        console.warn(
          `[comfy-live] 诊断日志写不回 Host（${(e && e.message) || e}）。`
          + '通常是插件配置里的 projectRoot 指向了别的机器。'
          + '已在浏览器内存里留了一份：控制台输入 window.__COMFY_LIVE_DIAG__ 查看。',
        )
      } catch { /* ignore */ }
    })
  } catch { /* ignore */ }
}
try { window.__COMFY_LIVE_DIAG__ = DIAG_BUF } catch { /* 非浏览器环境 */ }

function diagInstall() {
  if (diagInstall.done) return
  diagInstall.done = true
  try {
    window.addEventListener('error', (e) => {
      diag('window.error', { msg: String((e && e.message) || ''), src: String((e && e.filename) || ''), line: e && e.lineno })
    })
    window.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason
      diag('window.reject', { msg: String((r && r.message) || r) })
    })
  } catch { /* ignore */ }
}

/** 把一次尝试的结果记下来，同时返回可读的短字符串（方便塞进 title/日志） */
function diagStep(tag, fn) {
  try {
    const v = fn()
    diag(tag, { ok: true, ret: v === undefined ? 'undefined' : String(v) })
    return v
  } catch (e) {
    diag(tag, { ok: false, error: String((e && e.message) || e) })
    throw e
  }
}

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
  sys: null,
  spark: [],
  tasks: [],
  taskId: null,
  rightbar: false,
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
      sys: j.sys || null,
      spark: Array.isArray(j.spark) ? j.spark : [],
      tasks: Array.isArray(j.tasks) ? j.tasks : [],
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

// ---- 任务层：一次需求 = 一个任务；挑中的图记在任务上（服务端落盘）

function mergeTask(task) {
  if (!task || !task.id) return
  const has = snap.tasks.some((t) => t.id === task.id)
  const tasks = has ? snap.tasks.map((t) => (t.id === task.id ? task : t)) : [task, ...snap.tasks]
  // 只在还没选过任务时决定初值：优先"有东西在跑"的那个，否则最新的
  let taskId = snap.taskId
  if (!taskId) taskId = (tasks.find((t) => t.running) || tasks[0]).id
  set({ tasks, taskId })
}

async function togglePick(taskId, item, runId) {
  if (!taskId || !item || !item.filename) return
  const body = {
    task: taskId,
    filename: item.filename,
    subfolder: item.subfolder || '',
    type: item.type || 'output',
    kind: item.kind || 'image',
    runId: runId || null,
  }
  try {
    const r = await fetch(`${API}/api/pick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await r.json()
    if (j && j.ok && j.task) mergeTask(j.task)
  } catch { /* 离线就等下一次 */ }
}

function mergeDetail(id, patch) {
  const details = { ...snap.details, [id]: { ...(snap.details[id] || {}), ...patch } }
  set({ details })
}

// 新任务真的开跑时的回调（用来把右侧栏叫出来）。只通知一次，不参与渲染。
const runWatchers = new Set()
function onFirstRun(fn) { runWatchers.add(fn); return () => runWatchers.delete(fn) }

function handleEvent(ev) {
  if (!ev || !ev.t) return
  if (ev.t === 'conn') { set({ connected: !!ev.connected }); return }
  if (ev.t === 'sys') {
    set({ sys: ev.sys || null, spark: Array.isArray(ev.spark) ? ev.spark : snap.spark })
    return
  }
  if (ev.t === 'task') { mergeTask(ev.task); return }
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
    if (!existed && isLive) for (const fn of runWatchers) { try { fn(run) } catch { /* ignore */ } }
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
