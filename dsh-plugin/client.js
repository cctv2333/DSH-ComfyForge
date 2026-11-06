/**
 * Comfy 实时台 — Client 半（由 client-src/*.js 拼装，勿直接编辑本文件）
 * 生成：node build-client.mjs
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-comfy-live',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // ─── 00-store.js ───────────────────────────────────────────────────
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

    // ─── 10-format.js ──────────────────────────────────────────────────
    // 10-format.js — 纯函数：时间、时长、节点名、参数抽取。没有 React、没有副作用。

    function two(n) { return String(n).padStart(2, '0') }

    function clock(ts) {
      if (!ts) return '--:--'
      const d = new Date(ts)
      return `${two(d.getHours())}:${two(d.getMinutes())}`
    }

    function dayLabel(ts) {
      if (!ts) return '更早'
      const d = new Date(ts)
      const now = new Date()
      const sameDay = d.toDateString() === now.toDateString()
      if (sameDay) return '今天'
      const y = new Date(now.getTime() - 86400000)
      if (d.toDateString() === y.toDateString()) return '昨天'
      return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
    }

    function dur(ms) {
      if (!ms || ms < 0) return ''
      const s = Math.round(ms / 1000)
      if (s < 60) return `${s} 秒`
      const m = Math.floor(s / 60)
      return `${m} 分 ${two(s % 60)} 秒`
    }

    function isLink(v) { return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number' }

    function displayName(classType) {
      return String(classType || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    }

    function statusText(status) {
      if (status === 'running') return '运行中'
      if (status === 'success') return '完成'
      if (status === 'error') return '失败'
      if (status === 'interrupted') return '已中断'
      return status || '未知'
    }

    /** 从 API 图里抽人看得懂的关键参数（不同工作流节点名不一样，按"第一个有该字段的节点"取） */
    function paramsOf(graph) {
      const out = []
      if (!graph) return out
      const nodes = Object.entries(graph)
      const pick = (test) => {
        for (const entry of nodes) { const v = test(entry[1].inputs || {}); if (v !== undefined && v !== null && v !== '') return v }
        return undefined
      }

      const prompt = nodes.find(([, n]) => typeof n.inputs?.text === 'string' && String(n.inputs.text).trim())
      if (prompt) out.push(['提示词', String(prompt[1].inputs.text).trim()])

      const width = pick((i) => i.width)
      const height = pick((i) => i.height)
      if (width && height) out.push(['尺寸', `${width} × ${height}`])

      const steps = pick((i) => (typeof i.steps === 'number' ? i.steps : undefined))
      const cfg = pick((i) => (typeof i.cfg === 'number' ? i.cfg : undefined))
      const samplerName = pick((i) => (typeof i.sampler_name === 'string' ? i.sampler_name : undefined))
      const scheduler = pick((i) => (typeof i.scheduler === 'string' ? i.scheduler : undefined))
      const sampling = [
        steps !== undefined ? `${steps} 步` : '',
        cfg !== undefined ? `cfg ${cfg}` : '',
        samplerName || '',
        scheduler || '',
      ].filter(Boolean).join(' · ')
      if (sampling) out.push(['采样', sampling])

      const seed = pick((i) => (i.seed !== undefined ? i.seed : i.noise_seed))
      if (seed !== undefined) out.push(['seed', String(seed)])

      const model = pick((i) => i.ckpt_name || i.unet_name || i.model_name)
      if (model) out.push(['模型', String(model)])

      const frames = pick((i) => (typeof i.num_frames === 'number' ? i.num_frames : undefined))
      if (frames) out.push(['帧数', String(frames)])

      return out
    }

    /** 产物按类型分：视频/动图要 <video>，静图要 <img> */
    function outputKind(o) {
      const name = String(o && o.filename || '').toLowerCase()
      if (/\.(mp4|webm|mov|mkv)$/.test(name)) return 'video'
      if (/\.(gif|webp)$/.test(name)) return 'animation'
      if (/\.(wav|mp3|flac|ogg)$/.test(name)) return 'audio'
      return 'image'
    }

    // ─── 20-graph-layout.js ────────────────────────────────────────────
    // 20-graph-layout.js — 只算坐标，不画图。
    // 分层（最长路径）→ 4 轮上下扫描的邻居重心排序（压交叉）→ 每列垂直居中。

    const NODE_W = 244
    const NODE_H = 68
    const COL_GAP = 88
    const ROW_GAP = 26
    const PAD = 32

    function layoutGraph(graph) {
      const ids = Object.keys(graph || {})
      if (!ids.length) return { pos: {}, edges: [], width: 420, height: 240 }

      const parents = Object.fromEntries(ids.map((id) => [id, []]))
      const children = Object.fromEntries(ids.map((id) => [id, []]))
      const edges = []
      for (const [id, n] of Object.entries(graph)) {
        for (const [name, v] of Object.entries(n.inputs || {})) {
          if (!isLink(v) || !graph[v[0]]) continue
          parents[id].push(v[0])
          children[v[0]].push(id)
          edges.push({ from: v[0], to: id, input: name })
        }
      }

      // 1) 分层：最长路径
      const rank = {}
      const visiting = new Set()
      const calc = (id) => {
        if (rank[id] !== undefined) return rank[id]
        if (visiting.has(id)) return 0
        visiting.add(id)
        let d = 0
        for (const p of parents[id] || []) d = Math.max(d, calc(p) + 1)
        visiting.delete(id)
        rank[id] = d
        return d
      }
      for (const id of ids) calc(id)

      const columns = {}
      for (const id of ids) (columns[rank[id]] ||= []).push(id)
      const ranks = Object.keys(columns).map(Number).sort((a, b) => a - b)
      const order = {}
      for (const r of ranks) order[r] = columns[r].slice().sort((a, b) => Number(a) - Number(b))

      // 2) 排序：4 轮，下扫按父节点重心、上扫按子节点重心
      const indexIn = (id, r) => {
        const col = order[r]
        return col ? col.indexOf(id) : -1
      }
      const sweep = (r, neighborRank, neighborsOf) => {
        const col = order[r]
        if (!col || col.length < 2) return
        const score = new Map()
        for (const id of col) {
          const ns = neighborsOf(id).map((n) => indexIn(n, neighborRank)).filter((x) => x >= 0)
          score.set(id, ns.length ? ns.reduce((s, x) => s + x, 0) / ns.length : 1e9)
        }
        col.sort((a, b) => (score.get(a) ?? 1e9) - (score.get(b) ?? 1e9))
      }
      for (let pass = 0; pass < 4; pass++) {
        for (const r of ranks) sweep(r, r - 1, (id) => parents[id] || [])
        for (let i = ranks.length - 1; i >= 0; i--) sweep(ranks[i], ranks[i] + 1, (id) => children[id] || [])
      }

      // 3) 坐标：每列自上而下堆，整列相对最高列垂直居中
      const maxRows = Math.max(...ranks.map((r) => order[r].length))
      const colHeight = (n) => Math.max(0, n - 1) * (NODE_H + ROW_GAP)
      const height = PAD * 2 + colHeight(maxRows) + NODE_H
      const pos = {}
      for (const r of ranks) {
        const col = order[r]
        const top = PAD + (colHeight(maxRows) - colHeight(col.length)) / 2
        col.forEach((id, i) => {
          pos[id] = { x: PAD + r * (NODE_W + COL_GAP), y: top + i * (NODE_H + ROW_GAP) }
        })
      }

      return {
        pos,
        edges,
        width: PAD * 2 + (ranks.length - 1) * (NODE_W + COL_GAP) + NODE_W,
        height,
      }
    }

    // ─── 30-components.js ──────────────────────────────────────────────
    // 30-components.js — 通用小组件。只认 props，不认数据来源。

    /** 只在需要时每秒重渲染一次（跑动中的耗时），别把整个面板拖进 1s 心跳 */
    function useTick(ms, enabled) {
      const [, force] = useState(0)
      useEffect(() => {
        if (!enabled) return undefined
        const id = setInterval(() => force((n) => n + 1), ms)
        return () => clearInterval(id)
      }, [ms, enabled])
    }

    function Section({ title, aside, children, bodyClass }) {
      return h('section', { className: 'cfl-card' },
        h('div', { className: 'cfl-card-head' },
          h('h2', { className: 'cfl-card-title' }, title),
          aside ? h('span', { className: 'cfl-card-aside' }, aside) : null),
        h('div', { className: `cfl-card-body${bodyClass ? ` ${bodyClass}` : ''}` }, children))
    }

    function Dot({ status }) {
      return h('span', { className: `cfl-dot is-${status || 'idle'}`, 'aria-hidden': true })
    }

    function Progress({ value, max, indeterminate }) {
      const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0
      return h('div', { className: `cfl-progress${indeterminate ? ' is-indeterminate' : ''}` },
        h('i', { style: { width: indeterminate ? '38%' : `${pct}%` } }))
    }

    function KV({ rows }) {
      return h('dl', { className: 'cfl-kv' }, rows.map(([k, v], i) =>
        h('div', { className: 'cfl-kv-row', key: i },
          h('dt', null, k),
          h('dd', { title: typeof v === 'string' ? v : undefined }, v))))
    }

    function Empty({ title, hint }) {
      return h('div', { className: 'cfl-empty' },
        h('p', { className: 'cfl-empty-title' }, title),
        hint ? h('p', { className: 'cfl-empty-hint' }, hint) : null)
    }

    /**
     * 图片兜底：加载失败就显示"产物已删除"，而不是留一个破图或一片空白。
     * 为什么需要：执行记录是从 ComfyUI 的 /history 回读的，里面的文件可能早被删了，
     * 界面上就会变成一堆灰块 + 裂图，看起来像面板坏了。
     */
    function MediaImg({ className, src, alt, badText }) {
      const [bad, setBad] = useState(false)
      if (!src) return h('span', { className: 'cfl-media-bad' }, badText || '无产物')
      if (bad) return h('span', { className: 'cfl-media-bad' }, badText || '产物已删除')
      return h('img', { className, src, alt: alt || '', loading: 'lazy', onError: () => setBad(true) })
    }

    function MediaThumb({ item, className }) {
      const kind = outputKind(item)
      if (kind === 'video') {
        return h('video', {
          className, src: item.url, muted: true, loop: true, autoPlay: true, playsInline: true, preload: 'metadata',
        })
      }
      if (kind === 'audio') {
        return h('span', { className: 'cfl-audio-badge' }, '音频')
      }
      return h(MediaImg, { className, src: item.url, alt: item.filename || '' })
    }

    function Legend() {
      const items = [
        ['cfl-lg-idle', '待跑'],
        ['cfl-lg-run', '在跑'],
        ['cfl-lg-done', '完成'],
        ['cfl-lg-cache', '缓存'],
        ['cfl-lg-error', '失败'],
      ]
      return h('div', { className: 'cfl-legend' }, items.map(([cls, text]) =>
        h('span', { key: cls, className: `cfl-legend-item ${cls}` }, h('i', null), text)))
    }

    // ─── 33-sys.js ─────────────────────────────────────────────────────
    // 33-sys.js — 系统监控条：显存 / 内存 / CPU + 迷你折线 + 看门狗。
    //
    // 数据来自 Host：每 2s 取一次 ComfyUI 的 /system_stats（显存、内存、版本），
    // CPU 用 node:os 的 cpus() 时间差自己算。SSE 推 {t:'sys', sys, spark}。
    // 这一条要能回答三个问题：现在能不能跑（连没连上）、会不会 OOM（显存还剩多少）、
    // 以及"监控本身还活着吗"（8s 没新数据 = 宿主/事件流断了）。

    const SYS_STALE_MS = 8000

    /** 8.06G / 16G 这种，比 8589934592 好读；统一一位小数，三行数值对齐才不跳 */
    function bytesText(n) {
      if (!n || n <= 0) return '—'
      const g = n / 1024 ** 3
      if (g >= 1) return `${g.toFixed(1)}G`
      return `${Math.round(n / 1024 ** 2)}M`
    }

    /**
     * 迷你折线：横轴最近 60 次采样（约 2 分钟），纵轴 0–100%。
     * 面积 = 显存占用，细线 = CPU。没有图库，60 个点的 SVG 自己画最省。
     */
    function SysSpark({ spark }) {
      const n = spark ? spark.length : 0
      if (n < 2) return h('div', { className: 'cfl-sys-spark is-empty' })
      const W = 100
      const H = 34
      const px = (i) => (i / (n - 1)) * W
      const py = (p) => (H - (Math.max(0, Math.min(100, Number(p) || 0)) / 100) * H).toFixed(2)
      const line = (idx) => spark.map((p, i) => `${px(i).toFixed(2)},${py(p[idx])}`).join(' ')
      const vram = line(2)
      return h('svg', {
        className: 'cfl-sys-spark',
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: 'none',
        role: 'img',
        'aria-label': '最近两分钟：面积 = 显存占用，细线 = CPU',
        'aria-hidden': true,
      },
      h('line', { className: 'cfl-spark-mid', x1: 0, y1: H / 2, x2: W, y2: H / 2 }),
      h('line', { className: 'cfl-spark-base', x1: 0, y1: H, x2: W, y2: H }),
      h('polygon', { className: 'cfl-spark-area', points: `0,${H} ${vram} ${W},${H}` }),
      h('polyline', { className: 'cfl-spark-vram', points: vram }),
      h('polyline', { className: 'cfl-spark-cpu', points: line(1) }))
    }

    function SysStrip({ sys, spark, connected }) {
      // 客户端看门狗：宿主每 2s 推一次，8s 没动静就不是"机器忙"，是监控断了
      const [, force] = useState(0)
      const mountedAt = useRef(Date.now())
      useEffect(() => {
        const id = setInterval(() => force((x) => x + 1), 2000)
        return () => clearInterval(id)
      }, [])

      if (!sys) {
        // 一直没有 sys 只有两种可能：还没连上，或者宿主是没这功能的旧版本
        const late = Date.now() - mountedAt.current > 6000
        return h('div', { className: 'cfl-sys is-pending' },
          h('span', { className: 'cfl-sys-note' }, !connected
            ? '未连接 ComfyUI'
            : late ? '宿主没有提供系统状态（插件是旧版本，重启 DSH 后生效）' : '读取系统状态…'))
      }

      const stale = !sys.at || Date.now() - sys.at > SYS_STALE_MS
      const down = !stale && !!sys.down
      const bad = stale || down
      const warn = !bad && sys.warn === 'vram_low'
      const vramUsed = sys.vramTotal ? sys.vramTotal - sys.vramFree : 0
      const ramUsed = sys.ramTotal ? sys.ramTotal - sys.ramFree : 0
      const rows = [
        ['CPU', sys.cpu == null ? '—' : `${sys.cpu}%`, false],
        ['显存', sys.vramTotal ? `${bytesText(vramUsed)}/${bytesText(sys.vramTotal)}` : '—', warn],
        ['内存', sys.ramTotal ? `${bytesText(ramUsed)}/${bytesText(sys.ramTotal)}` : '—', false],
      ]
      const title = [
        sys.gpu ? `GPU ${sys.gpu}` : '',
        sys.version ? `ComfyUI ${sys.version}` : '',
        sys.python ? `Python ${sys.python}` : '',
        sys.at ? `采样于 ${clock(sys.at)}` : '',
      ].filter(Boolean).join(' · ')

      return h('div', { className: `cfl-sys${bad ? ' is-down' : warn ? ' is-warn' : ''}`, title },
        h('div', { className: 'cfl-sys-main' },
          h(SysSpark, { spark }),
          h('div', { className: 'cfl-sys-stats' }, rows.map(([k, v, isWarn]) =>
            h('div', { key: k, className: `cfl-sys-stat${isWarn ? ' is-warn' : ''}` },
              h('em', null, k),
              h('b', null, v))))),
        bad || warn ? h('div', { className: 'cfl-sys-alert' },
          h('b', null, stale ? '监控中断' : down ? 'ComfyUI 无响应' : '显存吃紧'),
          h('span', null, stale
            ? '已经 8 秒收不到系统状态，宿主或事件流可能断了。'
            : down
              ? `连续 ${sys.fails} 次取不到 /system_stats，现在提交会失败。`
              : `空闲显存 ${bytesText(sys.vramFree)}，下一次提交可能 OOM。`)) : null)
    }

    // ─── 35-workbench.js ───────────────────────────────────────────────
    // 35-workbench.js — 工作台外壳：左侧导航 + 产物库 + 工作流库。
    // 和 40-views（执行视图）平级；三者共用 00-store。

    function formatBytes(n) {
      if (!n) return ''
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
      return `${(n / 1024 / 1024).toFixed(1)} MB`
    }

    function ago(ts) {
      if (!ts) return ''
      const d = Date.now() - ts
      if (d < 60000) return '刚刚'
      if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`
      if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`
      return `${Math.floor(d / 86400000)} 天前`
    }

    const RAIL = [
      { id: 'runs', label: '执行', icon: 'M4 5h16M4 12h10M4 19h7' },
      { id: 'assets', label: '产物', icon: 'M4 5h7v7H4zM13 5h7v7h-7zM4 14h7v5H4zM13 14h7v5h-7z' },
      { id: 'workflows', label: '工作流', icon: 'M5 6h6v4H5zM13 14h6v4h-6zM8 10v4h5' },
    ]

    function Rail({ tab, s, onChange }) {
      const counts = {
        runs: (s.runs || []).length,
        assets: s.library && s.library.total ? s.library.total : null,
        workflows: s.workflows && s.workflows.items ? s.workflows.items.length : null,
      }
      return h('nav', { className: 'cfl-rail', 'aria-label': '工作台' },
        h('div', { className: 'cfl-rail-title' }, '工作台'),
        RAIL.map((item) => h('button', {
          key: item.id,
          type: 'button',
          className: `cfl-rail-item${tab === item.id ? ' is-active' : ''}`,
          onClick: () => onChange(item.id),
          title: item.label,
        },
        h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: item.icon })),
        h('span', null, item.label),
        counts[item.id] ? h('em', null, counts[item.id]) : null)))
    }

    function AssetsView({ s }) {
      const lib = s.library
      const [kind, setKind] = useState('all')
      const [open, setOpen] = useState(null)
      // 一次只挂 60 张：328 张原图同时加载会把滚动和首屏拖死
      const [limit, setLimit] = useState(60)
      useEffect(() => { setLimit(60) }, [kind])
      const items = (lib && lib.items) || []
      const filtered = kind === 'all' ? items : items.filter((x) => (x.kind || 'image') === kind)
      const shown = filtered.slice(0, limit)
      const counts = { all: items.length, image: 0, video: 0, animation: 0 }
      for (const x of items) counts[x.kind || 'image'] = (counts[x.kind || 'image'] || 0) + 1

      const chips = [['all', `全部 ${counts.all}`], ['image', `图片 ${counts.image}`], ['video', `视频 ${counts.video}`], ['animation', `动图 ${counts.animation}`]]

      return h('div', { className: 'cfl-w-content' },
        h('div', { className: 'cfl-w-head' },
          h('div', null,
            h('h2', { className: 'cfl-w-title' }, '产物库'),
            h('p', { className: 'cfl-w-sub' }, lib && lib.ok
              ? `直接扫 ComfyUI 的 output 目录 · ${lib.total} 个文件`
              : (lib && lib.error) || '读取中…')),
          h('div', { className: 'cfl-w-actions' },
            h('div', { className: 'cfl-chips' }, chips.map(([id, text]) => h('button', {
              key: id,
              type: 'button',
              className: `cfl-chip${kind === id ? ' is-on' : ''}`,
              onClick: () => setKind(id),
            }, text))),
            h('button', { type: 'button', className: 'cfl-btn', onClick: () => loadLibrary(true) }, '刷新'))),

        !lib
          ? h('div', { className: 'cfl-w-empty' }, '正在读取产物…')
          : !lib.ok
            ? h('div', { className: 'cfl-w-empty' }, lib.error || '读不到产物目录')
            : filtered.length === 0
              ? h('div', { className: 'cfl-w-empty' }, '这个分类还没有文件。在 ComfyUI 里跑一张，产物会自动出现在这里（这里直接读 output 目录，不用手动导入）')
              : h('div', { className: 'cfl-grid-wrap' },
                h('div', { className: 'cfl-grid' }, shown.map((item) => h('button', {
                  key: `${item.subfolder}/${item.filename}`,
                  type: 'button',
                  className: 'cfl-tile',
                  onClick: () => setOpen(item),
                  title: `${item.subfolder ? item.subfolder + '/' : ''}${item.filename}`,
                },
                h('span', { className: 'cfl-tile-frame' },
                  item.kind === 'video'
                    ? h('video', { className: 'cfl-tile-media', src: `${item.url}#t=0.1`, muted: true, preload: 'metadata', playsInline: true })
                    : h(MediaImg, { className: 'cfl-tile-media', src: item.url, alt: '' }),
                  item.kind === 'video' ? h('span', { className: 'cfl-tile-badge' }, '视频') : null,
                  h('span', { className: 'cfl-tile-meta' },
                    h('span', { className: 'cfl-tile-name' }, item.filename),
                    h('span', { className: 'cfl-tile-sub' },
                      [item.w && item.h ? `${item.w}×${item.h}` : '', ago(item.mtime), formatBytes(item.bytes)]
                        .filter(Boolean).join(' · '))))))),
                limit < filtered.length
                  ? h('div', { className: 'cfl-more' },
                    h('button', {
                      type: 'button',
                      className: 'cfl-btn',
                      onClick: () => setLimit((n) => n + 60),
                    }, `加载更多（还有 ${filtered.length - limit} 个）`))
                  : null),

        open
          ? h('div', { className: 'cfl-lightbox', onClick: () => setOpen(null) },
            h('div', { className: 'cfl-lightbox-body', onClick: (e) => e.stopPropagation() },
              h('div', { className: 'cfl-lightbox-head' },
                h('span', null, `${open.subfolder ? open.subfolder + ' / ' : ''}${open.filename}`),
                h('button', { type: 'button', className: 'cfl-icon-btn', onClick: () => setOpen(null) }, '×')),
              open.kind === 'video'
                ? h('video', { className: 'cfl-lightbox-media', src: open.url, controls: true, autoPlay: true, loop: true, playsInline: true })
                : h('img', { className: 'cfl-lightbox-media', src: open.url, alt: open.filename }),
              h('div', { className: 'cfl-lightbox-foot' },
                h('a', { className: 'cfl-btn', href: open.url, target: '_blank', rel: 'noreferrer' }, '在新标签打开'),
                h('span', { className: 'cfl-w-sub' }, `${formatBytes(open.bytes)} · ${open.mtime ? new Date(open.mtime).toLocaleString('zh-CN', { hour12: false }) : ''}`))))
          : null)
    }

    function WorkflowsView({ s, onBack }) {
      const list = s.workflows
      if (s.wfPreview) {
        return h('div', { className: 'cfl-w-content' },
          h('div', { className: 'cfl-w-head' },
            h('div', null,
              h('h2', { className: 'cfl-w-title' }, s.wfPreview.name),
              h('p', { className: 'cfl-w-sub' }, s.wfPreview.title || '只读预览 · 这是 workflows/ 里的模板')),
            h('div', { className: 'cfl-w-actions' },
              h('button', { type: 'button', className: 'cfl-btn', onClick: onBack }, '返回列表'))),
          h('div', { className: 'cfl-w-canvas' },
            h(GraphBoard, {
              preview: true,
              run: { id: s.wfPreview.name, label: s.wfPreview.name, status: 'success', error: null, nodeCount: Object.keys(s.wfPreview.graph || {}).length },
              detail: { graph: s.wfPreview.graph, nodeStates: {} },
            })))
      }

      const items = (list && list.items) || []
      return h('div', { className: 'cfl-w-content' },
        h('div', { className: 'cfl-w-head' },
          h('div', null,
            h('h2', { className: 'cfl-w-title' }, '工作流库'),
            h('p', { className: 'cfl-w-sub' }, `workflows/ 里的模板 · ${items.length} 个`)),
          h('div', { className: 'cfl-w-actions' },
            h('button', { type: 'button', className: 'cfl-btn', onClick: () => loadWorkflows(true) }, '刷新'))),
        !list
          ? h('div', { className: 'cfl-w-empty' }, '正在读取模板…')
          : items.length === 0
            ? h('div', { className: 'cfl-w-empty' }, 'workflows/ 目录里没有 .json 模板')
            : h('div', { className: 'cfl-rows' }, items.map((item) => h('button', {
              key: item.name,
              type: 'button',
              className: 'cfl-row',
              onClick: () => openWorkflow(item.name),
            },
            h('span', { className: 'cfl-row-main' },
              h('span', { className: 'cfl-row-title' }, item.name),
              h('span', { className: 'cfl-row-sub' }, item.title || '（无标题）')),
            h('span', { className: 'cfl-row-tag' }, `${item.nodes} 节点`),
            item.model ? h('span', { className: 'cfl-row-tag' }, item.model) : null,
            h('span', { className: 'cfl-row-time' }, ago(item.updated))))))
    }

    function Workbench({ s, children }) {
      const onTab = useCallback((tab) => {
        set({ tab })
        if (tab === 'assets') loadLibrary()
        if (tab === 'workflows') loadWorkflows()
      }, [])
      return h('div', { className: 'cfl-shell' },
        h(Rail, { tab: s.tab, s, onChange: onTab }),
        children)
    }

    // ─── 37-float.js ───────────────────────────────────────────────────
    // 37-float.js — 右下角那个入口按钮（只有一个按钮，没有浮窗、没有抽屉）。
    //
    // 2026-11-05 定案：工作台是右侧那一整列（跟左栏相对）；这里只负责"怎么进那一列"。
    // 用户的三条要求，逐一对应：
    //   1) **能拖**：按住它就能拖到别处，位置记在 localStorage。
    //      坑（都处理了）：只认左键会让人觉得中键拖不动 → 左键+中键都收；
    //      不快 setPointerCapture 时指针拖出元素会断；不 preventDefault 会变成拖选文字；
    //      松手不解绑会越拖越卡。
    //   2) **能藏**：点 × 就彻底消失（挡住内容时用）。找回来走左栏的「Comfy 工作台」。
    //   3) **能进**：单击（没拖动）→ 打开右侧那一整列。

    const PILL_KEY = 'cfl.pill.v1'

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
    const vw = () => (typeof window !== 'undefined' && window.innerWidth) || 1440
    const vh = () => (typeof window !== 'undefined' && window.innerHeight) || 900
    const PILL_W = 132
    const PILL_H = 38

    function defaultPill() {
      return { x: Math.max(8, vw() - PILL_W - 16), y: Math.max(8, vh() - PILL_H - 16), hidden: false }
    }

    function loadPill() {
      const d = defaultPill()
      try {
        const j = JSON.parse(localStorage.getItem(PILL_KEY) || '{}')
        const num = (v, dv) => (Number.isFinite(Number(v)) ? Number(v) : dv)
        return {
          x: clamp(num(j.x, d.x), 0, Math.max(0, vw() - PILL_W)),
          y: clamp(num(j.y, d.y), 0, Math.max(0, vh() - PILL_H)),
          // hidden 故意**不持久化**：藏起来只对本次有效，刷新/重启一定回来。
          // 之前存了它，用户藏掉之后四面八方都找不到入口 —— 那就是"再也找不回来"。
          hidden: false,
        }
      } catch { return d }
    }

    /**
     * 位置不再存在 localStorage：DSH 每次启动端口都变，origin 跟着变，
     * 存储等于每次都是空的 —— 那就是"每次打开都跑到中间、每次都要重新挪"。
     * 现在 x/y 由 Host 磁盘上的 runs/ui-state.json 提供；没存过就用 x=null，
     * 渲染时靠 CSS 贴右边，绝不靠“算出来的默认坐标”（算早了会算到 0，跑到左上/中间）。
     */
    let pillState = { x: null, y: null, hidden: false }
    const pillListeners = new Set()

    function usePill() {
      const [v, setV] = useState(pillState)
      useEffect(() => {
        const fn = () => setV(pillState)
        pillListeners.add(fn)
        return () => pillListeners.delete(fn)
      }, [])
      return v
    }

    function setPill(patch) {
      pillState = { ...pillState, ...patch }
      for (const fn of pillListeners) { try { fn() } catch { /* ignore */ } }
    }

    /** 把位置写到 Host 磁盘（跟端口无关，下次启动还在原处） */
    function persistPillPos() {
      if (pillState.x === null || pillState.y === null) return
      patchUiPrefs({ pill: { x: Math.round(pillState.x), y: Math.round(pillState.y) } })
    }

    /** 运行中的步数短文案 */
    function step0(run) {
      const p = run && run.progress
      return p && p.max ? `${p.value}/${p.max} 步` : '在跑'
    }

    function makeFloatPanel(ctx, openWorkbench) {
      return function EntryPill() {
        const s = useStore()
        const p = usePill()
        const [mainOpen, setMainOpen] = useState(false)
        const [paneOpen, setPaneOpen] = useState(false)
        const dragRef = useRef(null)

        // 主面板是否在显示
        useEffect(() => {
          const check = () => {
            const el = document.querySelector('.cfl-main:not(.is-compact)')
            setMainOpen(!!el && el.offsetParent !== null)
            let open = false
            try {
              const right = UI_CTX && typeof UI_CTX.get === 'function' ? UI_CTX.get('sidebarRight') : null
              open = !!(right && typeof right.isExpanded === 'function' && right.isExpanded())
            } catch { open = false }
            setPaneOpen(open)
          }
          check()
          const id = setInterval(check, 800)
          return () => clearInterval(id)
        }, [])

        // 藏起来只在"还有别的路能进工作台"时成立。
        // 面板一关（右栏收起 / 主面板退出），按钮必须自己回来 —— 否则就是永远找不回来。
        useEffect(() => {
          if (pillState.hidden && !mainOpen && !paneOpen) setPill({ hidden: false })
        }, [mainOpen, paneOpen])

        // 首次挂载：从 Host 磁盘读回上次放的位置（跨启动有效，跟端口无关）
        useEffect(() => {
          let alive = true
          loadUiPrefs().then((prefs) => {
            if (!alive) return
            const q = prefs && prefs.pill
            if (!q || !Number.isFinite(Number(q.x)) || !Number.isFinite(Number(q.y))) return
            setPill({
              x: clamp(Number(q.x), 0, Math.max(0, vw() - PILL_W)),
              y: clamp(Number(q.y), 0, Math.max(0, vh() - PILL_H)),
            })
          }).catch(() => { /* 读不到就用默认贴右 */ })
          return () => { alive = false }
        }, [])

        // 视口变了把它拉回可见范围
        useEffect(() => {
          const onResize = () => {
            if (pillState.x === null) return
            setPill({
              x: clamp(pillState.x, 0, Math.max(0, vw() - PILL_W)),
              y: clamp(pillState.y, 0, Math.max(0, vh() - PILL_H)),
            })
          }
          window.addEventListener('resize', onResize)
          return () => window.removeEventListener('resize', onResize)
        }, [])

        const live = s.runs.find((r) => r.status === 'running') || null

        // 面板开着时允许藏；面板关着就一定显示（这条保证"永远找得回来"）
        if (p.hidden && (mainOpen || paneOpen)) return null

        // 按下：先记起点，不立刻移动；松手时看位移决定"拖"还是"点"
        const onDown = (e) => {
          if (e.button !== 0 && e.button !== 1) return
          e.preventDefault()
          e.stopPropagation()
          try { if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
          const startX = e.clientX
          const startY = e.clientY
          // 还没有保存过位置时（x=null，靠 CSS 贴右），从元素的真实矩形起算，
          // 否则第一次拖会从 (0,0) 起跳，看着就像"一拖就飞回中间"。
          let baseX = pillState.x
          let baseY = pillState.y
          if (baseX === null || baseY === null) {
            const r = e.currentTarget.getBoundingClientRect()
            baseX = r.left
            baseY = r.top
            setPill({ x: baseX, y: baseY })
          }
          let moved = 0
          dragRef.current = { moved: 0 }
          const move = (ev) => {
            const dx = ev.clientX - startX
            const dy = ev.clientY - startY
            moved = Math.max(moved, Math.abs(dx) + Math.abs(dy))
            dragRef.current && (dragRef.current.moved = moved)
            if (moved < 4) return // 手指抖动不算拖
            setPill({
              x: clamp(baseX + dx, 0, Math.max(0, vw() - PILL_W)),
              y: clamp(baseY + dy, 0, Math.max(0, vh() - PILL_H)),
            })
          }
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            window.removeEventListener('pointercancel', up)
            if (dragRef.current && dragRef.current.moved >= 4) persistPillPos() // 位置写磁盘
            const wasDrag = dragRef.current && dragRef.current.moved >= 4
            dragRef.current = null
            if (!wasDrag) {
              // 单击：进右侧那一整列；开不出来就提示一句，绝不静默
              let opened = false
              try { opened = !!(openWorkbench && openWorkbench()) } catch { opened = false }
              if (!opened) {
                diag('pill.open-failed', {})
                set({ error: '右侧栏打不开：请按 Ctrl+Alt+B 展开右侧栏后再点，或用左栏的 Comfy 工作台' })
              }
            }
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
          window.addEventListener('pointercancel', up)
        }

        return h('div', { className: 'cfl-layer' },
          h(Styles),
          h('div', {
            className: 'cfl-pill-wrap',
            // 没存过位置就走 CSS 贴右下角（不靠计算，算早了会落到中间/左上）
            style: p.x === null || p.y === null
              ? { right: '16px', bottom: '16px', width: `${PILL_W}px`, height: `${PILL_H}px` }
              : { left: `${p.x}px`, top: `${p.y}px`, width: `${PILL_W}px`, height: `${PILL_H}px` },
          },
            h('button', {
              type: 'button',
              className: `cfl-dock${live ? ' is-run' : ''}${s.connected ? '' : ' is-off'}`,
              title: '单击打开右侧工作台 · 按住可拖动 · 点 × 隐藏',
              onPointerDown: onDown,
            },
            h('i', { className: 'cfl-dock-dot' }),
            h('span', { className: 'cfl-dock-label' }, 'Comfy 工作台'),
            live ? h('span', { className: 'cfl-dock-meta' }, step0(live)) : null),
            // 隐藏按钮：只在 hover 时显形，不占视觉
            h('button', {
              type: 'button',
              className: 'cfl-pill-hide',
              title: '隐藏（用左栏「Comfy 工作台」可以找回来）',
              onClick: (e) => { e.stopPropagation(); diag('pill.hide'); setPill({ hidden: true }) },
            }, '×')))
      }
    }

    // ─── 40-views.js ───────────────────────────────────────────────────
    // 40-views.js — 页面分块。每块独立：TopBar / Timeline / GraphBoard / Inspector / Panel。
    // 换样式只动 50-styles.js，换数据只看 00-store.js。

    function TopBar({ s, live, onFollow, onJump }) {
      const tab = s.tab || 'runs'
      const running = live && live.status === 'running'
      const step = live && live.progress && live.progress.max
        ? `${live.progress.value}/${live.progress.max} 步`
        : '准备中'

      // 动作跟着当前模块走：在产物库里不该出现"跳到进行中"
      const actions = []
      if (tab === 'runs') {
        actions.push(running
          ? h('span', { key: 'st', className: 'cfl-pill is-run' }, h('i', null), `正在跑 · ${step}`)
          : h('span', { key: 'st', className: 'cfl-pill' }, s.connected ? '空闲' : '未连接'))
        if (s.queue) actions.push(h('span', { key: 'q', className: 'cfl-pill' }, `队列 ${s.queue}`))
        actions.push(h('button', {
          key: 'follow',
          type: 'button',
          className: `cfl-btn${s.following ? ' is-on' : ''}`,
          onClick: onFollow,
          title: '新任务开始时自动切到它',
        }, s.following ? '跟随最新' : '跟随已关'))
        actions.push(h('button', {
          key: 'jump',
          type: 'button',
          className: 'cfl-btn',
          onClick: onJump,
          disabled: !live,
        }, '跳到进行中'))
        actions.push(h('button', {
          key: 'float',
          type: 'button',
          className: 'cfl-btn',
          title: '右侧浮窗：一边聊天一边看进度',
          onClick: () => setFloat({ open: true }),
        }, '浮窗'))
      } else if (tab === 'assets') {
        actions.push(h('span', { key: 'n', className: 'cfl-pill' },
          s.library && s.library.total ? `${s.library.total} 个文件` : '读取中…'))
        actions.push(h('button', { key: 'r', type: 'button', className: 'cfl-btn', onClick: () => loadLibrary(true) }, '刷新'))
      } else {
        actions.push(h('span', { key: 'n', className: 'cfl-pill' },
          s.workflows && s.workflows.items ? `${s.workflows.items.length} 个模板` : '读取中…'))
        actions.push(h('button', { key: 'r', type: 'button', className: 'cfl-btn', onClick: () => loadWorkflows(true) }, '刷新'))
      }
      if (s.comfyUrl) {
        actions.push(h('a', {
          key: 'comfy',
          className: 'cfl-btn is-link',
          href: s.comfyUrl,
          target: '_blank',
          rel: 'noreferrer',
        }, '打开 ComfyUI'))
      }

      return h('header', { className: 'cfl-top' },
        h('div', { className: 'cfl-brand' },
          h('span', { className: `cfl-conn${s.connected ? ' is-on' : ''}`, 'aria-hidden': true }),
          h('h1', { className: 'cfl-brand-title' }, 'Comfy 工作台'),
          h('span', { className: 'cfl-brand-url' }, s.comfyUrl || '连不上 ComfyUI')),
        h('div', { className: 'cfl-top-actions' }, actions))
    }

    function Timeline({ s, onSelect }) {
      const runs = s.runs || []
      if (!runs.length) {
        return h('div', { className: 'cfl-col cfl-col-timeline' },
          h('div', { className: 'cfl-col-head' }, h('h2', null, '执行时间线'), h('span', null, '0')),
          h('div', { className: 'cfl-col-body' },
            h(Empty, {
              title: s.ready && !s.connected ? '连不上 ComfyUI' : '还没有执行记录',
              hint: s.ready && !s.connected
                ? '确认 ComfyUI 在本机 8188 跑着，然后刷新。'
                : '跑一次任务，这里会实时出现，并留下这次执行的完整节点图。',
            })))
      }

      const groups = []
      for (const run of runs) {
        const key = run.status === 'running' ? '正在跑' : dayLabel(run.startedAt)
        const last = groups[groups.length - 1]
        if (last && last.key === key) last.items.push(run)
        else groups.push({ key, items: [run] })
      }

      return h('div', { className: 'cfl-col cfl-col-timeline' },
        h('div', { className: 'cfl-col-head' },
          h('h2', null, '执行时间线'),
          h('span', null, `${runs.length} 次`)),
        h('div', { className: 'cfl-col-body' },
          groups.map((g) => h('div', { className: 'cfl-group', key: g.key },
            h('div', { className: 'cfl-group-label' }, g.key),
            g.items.map((run) => {
              const active = run.id === s.selectedId
              return h('button', {
                key: run.id,
                type: 'button',
                className: `cfl-run${active ? ' is-active' : ''}`,
                onClick: () => onSelect(run.id),
                title: run.label || '执行', // 长标题截断后鼠标悬停能看全
              },
              h(Dot, { status: run.status }),
              h('span', { className: 'cfl-run-text' },
                h('span', { className: 'cfl-run-label' }, run.label || '执行'),
                h('span', { className: 'cfl-run-meta' },
                  clock(run.startedAt),
                  run.status === 'running' ? ' · 进行中' : run.durationMs ? ` · ${dur(run.durationMs)}` : '',
                  run.outputs ? ` · ${run.outputs} 个产物` : '')),
              run.thumb ? h(MediaImg, { className: 'cfl-run-thumb', src: run.thumb, alt: '' }) : null)
            })))))
    }

    function GraphBoard({ run, detail, preview }) {
      const graph = detail && detail.graph
      const l = useMemo(() => layoutGraph(graph || {}), [graph])
      const wrapRef = useRef(null)
      // 默认 100%：39 节点的图缩到 28% 等于看不见。要看全图按「适应」。
      const [view, setView] = useState({ x: 20, y: 20, k: 1 })
      const viewRef = useRef(view)
      viewRef.current = view

      // 适应窗口：整图缩放进画布并居中（只在用户点「适应」/双击时发生，不自动改视角）
      const fit = useCallback(() => {
        const el = wrapRef.current
        if (!el) return
        const w = el.clientWidth - 48
        const hgt = el.clientHeight - 48
        if (w <= 0 || hgt <= 0) return
        const k = Math.max(0.15, Math.min(1, Math.min(w / l.width, hgt / l.height)))
        setView({
          k,
          x: (el.clientWidth - l.width * k) / 2,
          y: (el.clientHeight - l.height * k) / 2,
        })
      }, [l.width, l.height])

      // 换了一次执行：把视角重置回 100%，否则会沿用上一张图的缩放
      const runKey = run ? run.id : ''
      useEffect(() => {
        setView({ x: 20, y: 20, k: 1 })
      }, [runKey])

      // 滚轮缩放到鼠标位置（必须 passive:false 才能 preventDefault）
      useEffect(() => {
        const el = wrapRef.current
        if (!el) return
        const onWheel = (e) => {
          e.preventDefault()
          const rect = el.getBoundingClientRect()
          const px = e.clientX - rect.left
          const py = e.clientY - rect.top
          const cur = viewRef.current
          const next = Math.max(0.25, Math.min(2.5, cur.k * Math.exp(-e.deltaY * 0.0015)))
          const r = next / cur.k
          setView({ k: next, x: px - (px - cur.x) * r, y: py - (py - cur.y) * r })
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return () => el.removeEventListener('wheel', onWheel)
      }, [])

      const zoomBy = useCallback((factor) => {
        const el = wrapRef.current
        if (!el) return
        const cur = viewRef.current
        const next = Math.max(0.25, Math.min(2.5, cur.k * factor))
        const r = next / cur.k
        const cx = el.clientWidth / 2
        const cy = el.clientHeight / 2
        setView({ k: next, x: cx - (cx - cur.x) * r, y: cy - (cy - cur.y) * r })
      }, [])

      // 按住拖动平移
      const onPointerDown = (e) => {
        if (e.button !== 0) return
        const el = wrapRef.current
        if (!el) return
        // 拖画布不该触发选字/原生拖拽（否则会拖出一片选区、像复制粘贴）
        e.preventDefault()
        const start = { px: e.clientX, py: e.clientY, x: viewRef.current.x, y: viewRef.current.y }
        try { el.setPointerCapture(e.pointerId) } catch { /* ignore */ }
        const move = (ev) => setView({
          ...viewRef.current,
          x: start.x + (ev.clientX - start.px),
          y: start.y + (ev.clientY - start.py),
        })
        const up = (ev) => {
          try { el.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
          el.removeEventListener('pointercancel', up)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
        el.addEventListener('pointercancel', up)
      }

      const nodeCount = graph ? Object.keys(graph).length : 0
      const edgeCount = l.edges.length

      return h('div', { className: 'cfl-col cfl-col-canvas' },
        h('div', { className: 'cfl-col-head' },
          h('h2', null, preview ? '模板节点图' : '执行画布'),
          h('div', { className: 'cfl-tools' },
            h('span', { className: 'cfl-tools-meta' }, graph ? `${nodeCount} 节点 · ${edgeCount} 连线` : '等待节点图'),
            h('button', { type: 'button', className: 'cfl-icon-btn', title: '缩小', onClick: () => zoomBy(1 / 1.2), disabled: !graph }, '−'),
            h('span', { className: 'cfl-zoom-val' }, `${Math.round(view.k * 100)}%`),
            h('button', { type: 'button', className: 'cfl-icon-btn', title: '放大', onClick: () => zoomBy(1.2), disabled: !graph }, '＋'),
            h('button', { type: 'button', className: 'cfl-tool-btn', onClick: fit, disabled: !graph }, '适应'))),
        h('div', {
          className: 'cfl-canvas-wrap',
          ref: wrapRef,
          onPointerDown,
          onDragStart: (e) => e.preventDefault(),
          onDoubleClick: fit,
        },
          !graph
            ? h(Empty, { title: '正在取这次执行的节点图…', hint: '图来自 ComfyUI 的 /queue 或 /history，不是示意图。' })
            : h('div', {
              className: 'cfl-canvas-stage',
              style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` },
            },
            h('svg', {
              width: l.width,
              height: l.height,
              viewBox: `0 0 ${l.width} ${l.height}`,
            }, [
                h('defs', { key: 'defs' },
                  h('marker', {
                    id: 'cfl-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5,
                    markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse',
                  }, h('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--dsw-alias-border-l2)' }))),
                ...l.edges.map((e) => {
                  const a = l.pos[e.from]
                  const b = l.pos[e.to]
                  if (!a || !b) return null
                  const x1 = a.x + NODE_W
                  const y1 = a.y + NODE_H / 2
                  const x2 = b.x
                  const y2 = b.y + NODE_H / 2
                  const mx = (x1 + x2) / 2
                  const src = (detail.nodeStates || {})[e.from]
                  return h('path', {
                    key: `e-${e.from}-${e.to}-${e.input}`,
                    d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
                    className: src === 'done' || src === 'cached' ? 'cfl-edge is-done' : 'cfl-edge',
                    markerEnd: 'url(#cfl-arrow)',
                  })
                }),
                ...Object.entries(graph).map(([id, n]) => {
                  const p = l.pos[id]
                  if (!p) return null
                  const st = (detail.nodeStates || {})[id] || 'pending'
                  const isError = st === 'error' || (run && run.error && run.error.node === id)
                  return h('g', {
                    key: `n-${id}`,
                    transform: `translate(${p.x},${p.y})`,
                    className: `cfl-node is-${isError && st !== 'running' ? 'error' : st}`,
                  },
                  h('rect', { className: 'cfl-node-box', width: NODE_W, height: NODE_H, rx: 10 }),
                  h('text', { className: 'cfl-node-title', x: 16, y: 27 }, displayName(n.class_type).slice(0, 26)),
                  h('text', { className: 'cfl-node-sub', x: 16, y: 47 },
                    `#${id}${st === 'running' ? ' · 正在跑' : st === 'done' ? ' · 完成' : st === 'cached' ? ' · 缓存' : st === 'error' ? ' · 失败' : ''}`),
                  h('circle', { className: 'cfl-node-state', cx: NODE_W - 16, cy: 18, r: 5 }))
                }),
            ])),
          h('div', { className: 'cfl-canvas-hint' }, '拖动平移 · 滚轮缩放 · 双击复位')),
        preview ? null : h('div', { className: 'cfl-col-foot' }, h(Legend)))
    }

    function Inspector({ run, detail, s }) {
      useTick(1000, !!(run && run.status === 'running'))
      // 灯箱：点预览图或产物缩略图放大看。窄列里图很小，没有放大就没法判断质量。
      const [big, setBig] = useState(null)
      if (!run) {
        return h('div', { className: 'cfl-col cfl-col-inspector' },
          h(Empty, { title: '左侧选一次执行', hint: '选中的这次会在这里显示状态、预览、产物和参数。' }))
      }

      const d = detail || {}
      const graph = d.graph || null
      const prog = d.progress || run.progress || null
      const total = run.nodeCount || (graph ? Object.keys(graph).length : 0)
      const done = d.nodeStates
        ? Object.values(d.nodeStates).filter((x) => x === 'done' || x === 'cached').length
        : 0
      const outputs = d.outputs || []
      const imageOut = outputs.filter((o) => outputKind(o) !== 'audio')
      const preview = d.preview || (imageOut.length ? imageOut[imageOut.length - 1].url : null)
      const previewKind = imageOut.length ? outputKind(imageOut[imageOut.length - 1]) : 'image'
      const params = paramsOf(graph)

      return h('div', { className: 'cfl-col cfl-col-inspector' },
        h(Section, { title: '这次执行', aside: statusText(run.status) },
          h(KV, {
            rows: [
              ['开始', clock(run.startedAt)],
              ['耗时', run.status === 'running' ? dur(Date.now() - run.startedAt) : (dur(run.durationMs) || '—')],
              ['节点', total ? `${done} / ${total}` : '—'],
              ['编号', String(run.id).slice(0, 8)],
            ],
          }),
          run.status === 'running'
            ? h('div', { className: 'cfl-progress-wrap' },
              h(Progress, {
                value: prog ? prog.value : 0,
                max: prog ? prog.max : 0,
                indeterminate: !prog || !prog.max,
              }),
              h('div', { className: 'cfl-progress-meta' },
                h('span', null, prog && prog.max ? `第 ${prog.value} / ${prog.max} 步` : '载入模型 / 处理中'),
                h('span', null, `${done} / ${total} 节点`)),
              h('button', {
                type: 'button',
                className: 'cfl-btn is-danger',
                onClick: () => { fetch(`${API}/api/interrupt`, { method: 'POST' }).catch(() => {}) },
              }, '中断这次'))
            : null,
          run.error
            ? h('div', { className: 'cfl-error' },
              h('b', null, '执行失败'),
              h('p', null, String(run.error.message || run.error).slice(0, 240)))
            : null),

        // 「实时预览」区：默认小图；点了产物/预览后在这里原地放大（不做覆盖层，
        // 覆盖层在窄列 + DSH 的定位上下文里很容易被裁掉，原地放大一定能看见）
        h(Section, { title: big ? '放大查看' : '实时预览', aside: big ? null : (run.status === 'running' ? '跟随采样' : null) },
          big
            ? h('div', { className: 'cfl-big' },
              big.kind === 'video'
                ? h('video', { className: 'cfl-big-img', src: big.url, controls: true, autoPlay: true, loop: true, playsInline: true })
                : h('img', { className: 'cfl-big-img', src: big.url, alt: big.name || '' }),
              // 收起做成浮在右上角的按钮：放在媒体下面会被视频撑出可视区，
              // 而且和视频自己的控制条（播放/进度/音量）挤在一起，抢不到点击。
              h('button', {
                type: 'button',
                className: 'cfl-big-close',
                title: '收起放大',
                onClick: () => setBig(null),
              }, '收起'),
              big.name ? h('div', { className: 'cfl-big-name' }, big.name) : null)
            : preview
              ? (previewKind === 'video'
                // 视频也要能点开：之前只给图片包了点击，跑视频模型时点预览毫无反应。
                ? h('button', {
                  type: 'button',
                  className: 'cfl-preview-btn',
                  title: '点击放大播放',
                  onClick: () => setBig({ url: preview, name: '实时预览', kind: 'video' }),
                }, h('video', { className: 'cfl-preview-media', src: preview, muted: true, loop: true, autoPlay: true, playsInline: true }))
                : h('button', {
                  type: 'button',
                  className: 'cfl-preview-btn',
                  title: '点击放大',
                  onClick: () => setBig({ url: preview, name: '实时预览帧', kind: 'image' }),
                }, h(MediaImg, { className: 'cfl-preview-media', src: preview, alt: '实时预览', badText: '预览帧已失效' })))
              : h('div', { className: 'cfl-preview-blank' },
                run.status === 'running'
                  ? (run.source === 'queue'
                    ? '这轮没有实时帧：任务不是经面板提交的，ComfyUI 只把预览发给提交者'
                    : '等第一帧…')
                  : '这次没有画面产物')),

        outputs.length
          ? h(Section, { title: '产物', aside: `${outputs.length} 个` },
            // 胶卷条：一行横滑，不抢纵向高度；点一下进灯箱看大图
            h('div', { className: 'cfl-film' }, outputs.slice(-24).map((o, i) =>
              h('button', {
                key: `${o.filename}-${i}`,
                type: 'button',
                className: 'cfl-film-item',
                title: `${o.filename}（点击放大）`,
                onClick: () => setBig({ url: o.url, name: o.filename, kind: outputKind(o) === 'video' ? 'video' : 'image' }),
              }, h(MediaThumb, { item: o, className: 'cfl-film-media' })))))
          : null,

        params.length
          ? h(Section, { title: '参数' },
            h('div', { className: 'cfl-params' }, params.map(([k, v], i) =>
              h('div', { className: 'cfl-param', key: i },
                h('span', null, k),
                h('p', null, String(v))))))
          : null
      )
    }

    function Panel({ compact }) {
      const s = useStore()

      useEffect(() => { boot() }, [])

      const run = s.runs.find((r) => r.id === s.selectedId) || null
      const detail = s.selectedId ? s.details[s.selectedId] : null
      const live = s.runs.find((r) => r.status === 'running') || null
      const onSelect = useCallback((id) => select(id, false), [])
      const onFollow = useCallback(() => {
        const next = !snap.following
        set({ following: next })
        if (next) {
          const target = live || s.runs[0]
          if (target) select(target.id, true)
        }
      }, [live, s.runs])
      const onJump = useCallback(() => { if (live) select(live.id, true) }, [live])

      // 浮窗模式：只有「这次执行」一列（状态 / 进度 / 预览 / 产物）。
      // 640px 里塞画布只会把两边都挤坏；要看图点右上角 ⤢ 去全屏工作台。
      if (compact) {
        return h('div', { className: 'cfl-root is-compact' },
          h(Styles),
          // 监控条放单列视图最上面
          h(SysStrip, { sys: s.sys, spark: s.spark, connected: s.connected }),
          s.error ? h('div', { className: 'cfl-banner' }, h('b', null, '出错'), s.error) : null,
          h('div', { className: 'cfl-main is-compact' },
            
            h(Inspector, { run, detail, s })))
      }

      return h('div', { className: 'cfl-root' },
        h(Styles),
        h(TopBar, { s, live, onFollow, onJump }),
        h(SysStrip, { sys: s.sys, spark: s.spark, connected: s.connected }),
        s.error ? h('div', { className: 'cfl-banner' }, h('b', null, '面板出错'), s.error) : null,
        h(Workbench, { s },
          s.tab === 'assets'
            ? h(AssetsView, { s })
            : s.tab === 'workflows'
              ? h(WorkflowsView, { s, onBack: () => set({ wfPreview: null }) })
              : h('div', { className: 'cfl-main' },
                h(Timeline, { s, onSelect }),
                h(GraphBoard, { run, detail }),
                h('div', { className: 'cfl-col cfl-col-inspector' },
                  
                  h(Inspector, { run, detail, s })))))
    }

    /**
     * DockPanel — 右侧整列停靠用（与左栏相对的那一列）。
     *
     * 设计要点（2026-11-05 定案）：
     *  · 它是"整列"，不是浮窗：贴右缘、通高、直角、只有一条左边线，和左栏同一套语言。
     *  · 它必须**功能完整**：执行 / 产物库 / 工作流 三个区都能进，而不是只显示一次执行的摘要。
     *  · 一列里放不下三栏画布，所以用「上列表、下详情、顶部三档切换」的结构：
     *    列表永远在（切走再回来不丢选择），详情区随选中项滚动。
     *  · 字号只用两档（13 / 12），分区靠留白和一条细线，不靠卡片套卡片。
     */
    function DockPanel() {
      const s = useStore()
      // 一挂载就在后台把产物库/工作流列表取回来：切过去是现成的，
      // 不用等、也不用点「刷新」。（之前只有点刷新才加载 —— 用户看到的就是一直"读取中"）
      useEffect(() => {
        boot()
        const t1 = setTimeout(() => { try { loadLibrary() } catch { /* ignore */ } }, 300)
        const t2 = setTimeout(() => { try { loadWorkflows() } catch { /* ignore */ } }, 1400)
        return () => { clearTimeout(t1); clearTimeout(t2) }
      }, [])

      const [seg, setSeg] = useState('run') // run | assets | workflows
      const [listOpen, setListOpen] = useState(true)

      const run = s.runs.find((r) => r.id === s.selectedId) || null
      const detail = s.selectedId ? s.details[s.selectedId] : null
      const live = s.runs.find((r) => r.status === 'running') || null
      const onSelect = useCallback((id) => select(id, false), [])

      // 切档即加载（有缓存就直接用，没有才请求）
      const goSeg = useCallback((key) => {
        setSeg(key)
        if (key === 'assets') { try { loadLibrary() } catch { /* ignore */ } }
        if (key === 'workflows') { try { loadWorkflows() } catch { /* ignore */ } }
      }, [])

      const segBtn = (key, label, extra) => h('button', {
        type: 'button',
        className: `cfl-seg-btn${seg === key ? ' is-on' : ''}`,
        onClick: () => goSeg(key),
      }, label, extra ? h('span', { className: 'cfl-seg-num' }, extra) : null)

      return h('div', { className: 'cfl-root cfl-dock2' },
        h(Styles),

        // 顶部：状态一行，分区切换一行（两行，避免挤在一行里抢宽度）
        h('div', { className: 'cfl-dock2-head' },
          h('span', { className: `cfl-conn${s.connected ? ' is-on' : ''}` }),
          h('b', { className: 'cfl-dock2-title' }, 'Comfy'),
          h('span', { className: 'cfl-dock2-live' },
            live ? (live.progress && live.progress.max ? `在跑 ${live.progress.value}/${live.progress.max}` : '在跑') : (s.ready ? '空闲' : '连接中')),
          // 藏掉右下角入口后，这里能把它找回来（不依赖刷新/重启）
          h('button', {
            type: 'button',
            className: 'cfl-icon-btn',
            title: '显示右下角入口按钮',
            onClick: () => { setPill({ hidden: false }) },
          }, '⌖')),
        h('div', { className: 'cfl-dock2-tabs' },
          h('div', { className: 'cfl-seg' },
            segBtn('run', '执行', s.runs.length || null),
            segBtn('assets', '产物'),
            segBtn('workflows', '工作流'))),

        h(SysStrip, { sys: s.sys, spark: s.spark, connected: s.connected }),
        s.error ? h('div', { className: 'cfl-banner' }, h('b', null, '出错'), s.error) : null,

        seg === 'assets'
          ? h('div', { className: 'cfl-dock2-body' }, h(AssetsView, { s }))
          : seg === 'workflows'
            ? h('div', { className: 'cfl-dock2-body' }, h(WorkflowsView, { s, onBack: () => set({ wfPreview: null }) }))
            : h('div', { className: 'cfl-dock2-run' },
              // 执行列表：默认展开，可折起给详情腾地方；折叠状态不影响功能
              h('div', { className: `cfl-dock2-list${listOpen ? '' : ' is-folded'}` },
                h('button', {
                  type: 'button',
                  className: 'cfl-dock2-listhead',
                  onClick: () => setListOpen(!listOpen),
                },
                h('span', null, '执行记录'),
                h('span', { className: 'cfl-dock2-count' }, `${s.runs.length}`),
                h('span', { className: 'cfl-dock2-fold' }, listOpen ? '收起' : '展开')),
                listOpen ? h('div', { className: 'cfl-dock2-listbody' }, h(Timeline, { s, onSelect })) : null),
              h('div', { className: 'cfl-dock2-detail' }, h(Inspector, { run, detail, s }))))
    }

    function PanelIcon(props) {
      const size = (props && props.size) || 20
      const active = !!(props && props.active)
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        opacity: active ? 1 : 0.82, 'aria-hidden': true, style: { display: 'block' },
      },
      h('rect', { x: 2.5, y: 6.5, width: 7, height: 5, rx: 1.4 }),
      h('rect', { x: 2.5, y: 14.5, width: 7, height: 5, rx: 1.4 }),
      h('rect', { x: 14.5, y: 10, width: 7, height: 6, rx: 1.4 }),
      h('path', { d: 'M9.5 9h2.4v4h2.6' }),
      h('path', { d: 'M9.5 17h2.4v-4' }))
    }

    function ComfyPanelBoundary() {
      const [err, setErr] = useState(null)
      if (err) {
        return h('div', { className: 'cfl-root' },
          h('div', { className: 'cfl-banner' },
            h('b', null, '面板渲染失败'),
            String(err && err.message ? err.message : err)))
      }
      return h(ErrorCatcher, { onError: setErr }, h(Panel))
    }

    class ErrorCatcher extends React.Component {
      constructor(props) { super(props); this.state = { err: null } }
      static getDerivedStateFromError(err) { return { err } }
      componentDidCatch(err) { this.props.onError && this.props.onError(err) }
      render() { return this.state.err ? null : this.props.children }
    }

    /**
     * 浮窗专用的边界。为什么必须有：
     * 没有边界时，浮窗里的 Panel 一抛错，React 会把整棵子树卸掉 —— 界面上就是
     * "点了完全没反应"，而且没有任何提示。用户遇到的就是这种沉默。
     * 现在出错会把原因写在浮窗里，同时写进 .cache/client-diag.log。
     */
    function ComfyFloatBoundary() {
      const [err, setErr] = useState(null)
      const onError = (e) => {
        diag('panel.error', { msg: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 800) })
        setErr(e)
      }
      if (err) {
        return h('div', { className: 'cfl-root' },
          h('div', { className: 'cfl-banner' },
            h('b', null, '面板渲染失败'),
            h('div', { style: { marginTop: '6px', whiteSpace: 'pre-wrap' } },
              String((err && err.message) || err))))
      }
      return h(ErrorCatcher, { onError }, h(Panel, { compact: true }))
    }

    /** 右侧整列停靠用的边界：出错时把原因写在面板里，而不是让整列静默变白 */
    function DockBoundary() {
      const [err, setErr] = useState(null)
      const onError = (e) => {
        diag('dock.error', { msg: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 800) })
        setErr(e)
      }
      if (err) {
        return h('div', { className: 'cfl-root' },
          h('div', { className: 'cfl-banner' },
            h('b', null, '面板渲染失败'),
            h('div', { style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, String((err && err.message) || err))))
      }
      return h(ErrorCatcher, { onError }, h(DockPanel))
    }

    // ─── 50-styles.js ──────────────────────────────────────────────────
    // 50-styles.js — 全部样式集中在这里（方便整体换皮）。
    // 字号只用三档：17（标题）/ 14（正文）/ 12.5（辅助）；间距 4 / 8 / 12 / 14 / 20。
    // 颜色只从主题 token 取；彩色只用于「状态」，不拿去装饰。

    function Styles() {
      return h('style', null, `
    .cfl-root{
      position:relative;
      --cfl-radius:12px;
      --cfl-gap:14px;
      --cfl-pad:14px;
      --cfl-fs-title:17px;
      --cfl-fs-body:14px;
      --cfl-fs-meta:12.5px;
      display:flex;
      flex-direction:column;
      height:100%;
      min-height:560px;
      overflow:hidden;
      background:var(--dsw-alias-bg-base);
      color:var(--dsw-alias-label-primary);
      font-size:var(--cfl-fs-body);
      line-height:1.55;
      /* 面板是操作界面，不是文档：默认不许选字，否则拖动画布会拖出一片选区 */
      user-select:none;
      -webkit-user-select:none;
    }
    /* 只有真正要读的文本允许选中复制 */
    .cfl-param p,.cfl-error p,.cfl-empty-hint{user-select:text;-webkit-user-select:text}

    /* ── 顶栏 ───────────────────────────────────────────── */
    .cfl-top{display:flex;align-items:center;gap:16px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
    .cfl-brand{display:flex;align-items:center;gap:10px;min-width:0}
    .cfl-brand-title{font-size:var(--cfl-fs-title);font-weight:600;margin:0;letter-spacing:-.01em;white-space:nowrap}
    .cfl-brand-url{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cfl-conn{width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
    .cfl-conn.is-on{background:var(--dsw-alias-state-success-primary)}
    .cfl-top-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
    .cfl-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--cfl-fs-meta);white-space:nowrap}
    .cfl-pill.is-run{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
    .cfl-pill.is-run i{width:7px;height:7px;border-radius:50%;background:currentColor;animation:cfl-pulse 1.3s ease-in-out infinite}
    .cfl-btn{appearance:none;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:var(--cfl-fs-meta);line-height:1;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;white-space:nowrap}
    .cfl-btn:hover{border-color:var(--dsw-alias-border-l2)}
    .cfl-btn.is-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
    .cfl-btn:disabled{opacity:.45;cursor:default}
    .cfl-btn.is-link{color:var(--dsw-alias-label-secondary)}
    .cfl-btn.is-danger{margin-top:10px;border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,var(--dsw-alias-border-l1));color:var(--dsw-alias-state-error-primary)}
    .cfl-btn.is-danger:hover{border-color:var(--dsw-alias-state-error-primary)}

    /* ── 三栏 ───────────────────────────────────────────── */
    .cfl-main{flex:1;min-width:0;min-height:0;display:grid;grid-template-columns:300px minmax(0,1fr) 360px;gap:var(--cfl-gap);padding:var(--cfl-gap);overflow:hidden}
    .cfl-col{min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--cfl-radius);overflow:hidden}
    .cfl-col-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:13px 14px 11px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
    .cfl-col-head h2{font-size:var(--cfl-fs-body);font-weight:600;margin:0}
    .cfl-col-head > span{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary);white-space:nowrap}
    .cfl-col-body{flex:1;min-height:0;overflow:auto;padding:10px}
    .cfl-col-canvas .cfl-col-body{padding:12px}
    .cfl-col-foot{flex:none;padding:9px 14px 11px;border-top:1px solid var(--dsw-alias-border-l1)}
    .cfl-col-inspector{background:transparent;border:0;border-radius:0;overflow:auto;padding-right:2px;gap:12px}

    /* ── 卡片（右栏分块）────────────────────────────────── */
    .cfl-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--cfl-radius);overflow:hidden;flex:none}
    .cfl-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:13px 14px 9px}
    .cfl-card-title{font-size:var(--cfl-fs-body);font-weight:600;margin:0}
    .cfl-card-aside{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary)}
    .cfl-card-body{padding:0 14px 14px}

    /* ── 时间线 ─────────────────────────────────────────── */
    .cfl-group{margin-bottom:6px}
    .cfl-group-label{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary);padding:8px 8px 4px}
    .cfl-run{display:flex;align-items:center;gap:10px;width:100%;padding:8px;border:1px solid transparent;border-radius:10px;background:transparent;color:inherit;text-align:left;cursor:pointer}
    .cfl-run:hover{background:var(--dsw-alias-bg-layer-2)}
    .cfl-run.is-active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
    .cfl-run-text{display:flex;flex-direction:column;min-width:0;flex:1;gap:2px}
    .cfl-run-label{font-size:var(--cfl-fs-body);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .cfl-run-meta{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
    .cfl-run-thumb{width:44px;height:44px;border-radius:8px;object-fit:cover;flex:none;background:var(--dsw-alias-bg-layer-2)}
    .cfl-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
    .cfl-dot.is-running{background:var(--dsw-alias-brand-primary);animation:cfl-pulse 1.3s ease-in-out infinite}
    .cfl-dot.is-success{background:var(--dsw-alias-state-success-primary)}
    .cfl-dot.is-error{background:var(--dsw-alias-state-error-primary)}
    .cfl-dot.is-interrupted{background:var(--dsw-alias-state-warn-primary)}

    /* ── 画布 / 节点 ────────────────────────────────────── */
    .cfl-col-canvas .cfl-col-body{padding:12px;overflow:hidden;display:flex}
    .cfl-canvas-wrap{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;border-radius:10px;background:var(--dsw-alias-bg-layer-2);background-image:radial-gradient(color-mix(in srgb,var(--dsw-alias-border-l2) 60%,transparent) 1px,transparent 1px);background-size:18px 18px;cursor:grab;touch-action:none}
    .cfl-canvas-wrap:active{cursor:grabbing}
    .cfl-canvas-stage{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
    .cfl-canvas-stage svg{display:block}
    .cfl-canvas-hint{position:absolute;left:10px;bottom:9px;font-size:12px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent);padding:3px 9px;border-radius:6px;pointer-events:none}
    .cfl-tools{display:flex;align-items:center;gap:6px}
    .cfl-tools-meta{margin-right:4px}
    .cfl-icon-btn{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:14px;line-height:1;padding:0}
    .cfl-icon-btn:hover{border-color:var(--dsw-alias-border-l2)}
    .cfl-icon-btn:disabled{opacity:.4;cursor:default}
    .cfl-zoom-val{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:40px;text-align:center;font-variant-numeric:tabular-nums}
    .cfl-tool-btn{height:24px;padding:0 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
    .cfl-tool-btn:hover{border-color:var(--dsw-alias-border-l2)}
    .cfl-tool-btn:disabled{opacity:.4;cursor:default}
    .cfl-node-box{fill:var(--dsw-alias-bg-layer-1);stroke:var(--dsw-alias-border-l2);stroke-width:1.2}
    .cfl-node-title{fill:var(--dsw-alias-label-primary);font-size:13.5px;font-weight:600}
    .cfl-node-sub{fill:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
    .cfl-node-state{fill:var(--dsw-alias-state-idle-primary)}
    .cfl-node.is-running .cfl-node-box{stroke:var(--dsw-alias-brand-primary);stroke-width:2.2;fill:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,var(--dsw-alias-bg-layer-1))}
    .cfl-node.is-running .cfl-node-state{fill:var(--dsw-alias-brand-primary);animation:cfl-pulse 1.1s ease-in-out infinite}
    .cfl-node.is-done .cfl-node-state{fill:var(--dsw-alias-state-success-primary)}
    .cfl-node.is-done .cfl-node-box{stroke:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,var(--dsw-alias-border-l2))}
    .cfl-node.is-cached .cfl-node-box{stroke-dasharray:5 4}
    .cfl-node.is-cached .cfl-node-state{fill:transparent;stroke:var(--dsw-alias-label-secondary);stroke-width:1.4}
    .cfl-node.is-error .cfl-node-box{stroke:var(--dsw-alias-state-error-primary);stroke-width:2.2;fill:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,var(--dsw-alias-bg-layer-1))}
    .cfl-node.is-error .cfl-node-state{fill:var(--dsw-alias-state-error-primary)}
    .cfl-edge{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:1.4;opacity:.8}
    .cfl-edge.is-done{stroke:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,var(--dsw-alias-border-l2));opacity:1}
    .cfl-legend{display:flex;flex-wrap:wrap;gap:14px}
    .cfl-legend-item{display:inline-flex;align-items:center;gap:6px;font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary)}
    .cfl-legend-item i{width:9px;height:9px;border-radius:3px;display:inline-block;background:var(--dsw-alias-state-idle-primary)}
    .cfl-lg-run i{background:var(--dsw-alias-brand-primary)}
    .cfl-lg-done i{background:var(--dsw-alias-state-success-primary)}
    .cfl-lg-cache i{background:transparent;border:1.4px dashed var(--dsw-alias-label-secondary)}
    .cfl-lg-error i{background:var(--dsw-alias-state-error-primary)}

    /* ── 右栏内容 ───────────────────────────────────────── */
    .cfl-kv{display:flex;flex-direction:column;gap:7px;margin:0}
    .cfl-kv-row{display:grid;grid-template-columns:52px 1fr;gap:10px;align-items:baseline}
    .cfl-kv dt{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary)}
    .cfl-kv dd{margin:0;font-size:var(--cfl-fs-body);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cfl-progress-wrap{margin-top:12px}
    .cfl-progress{height:6px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
    .cfl-progress i{display:block;height:100%;border-radius:99px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
    .cfl-progress.is-indeterminate i{animation:cfl-slide 1.3s ease-in-out infinite}
    .cfl-progress-meta{display:flex;justify-content:space-between;font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary);margin-top:6px;font-variant-numeric:tabular-nums}
    .cfl-preview-media{display:block;width:100%;max-height:300px;object-fit:contain;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
    .cfl-preview-blank{display:flex;align-items:center;justify-content:center;height:150px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--cfl-fs-meta);text-align:center;padding:0 14px;line-height:1.6}
    /* 产物文件没了时的占位：宁可写清楚"已删除"，也不要留一块灰或者裂图 */
    .cfl-media-bad{display:flex;align-items:center;justify-content:center;width:100%;height:100%;min-height:42px;padding:6px;
      border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
      font-size:11.5px;text-align:center;box-sizing:border-box}
    .cfl-thumbs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
    /* 产物格 + 右上角"选这张" */
    .cfl-thumb-wrap{position:relative;min-width:0}
    .cfl-pick{position:absolute;right:5px;top:5px;width:23px;height:23px;display:flex;align-items:center;justify-content:center;
      padding:0;border-radius:7px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);
      background:color-mix(in srgb,var(--dsw-alias-bg-base) 78%,transparent);color:var(--dsw-alias-label-secondary);
      font-size:13px;line-height:1;cursor:pointer;backdrop-filter:blur(2px)}
    .cfl-pick:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
    .cfl-pick.is-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
    /* 任务条 */
    .cfl-task-label{font-size:13px;color:var(--dsw-alias-label-primary);margin-bottom:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cfl-task-chips{display:flex;align-items:center;gap:6px;overflow-x:auto;padding:9px 0 2px;scrollbar-width:none}
    .cfl-task-chips::-webkit-scrollbar{display:none}
    .cfl-task-chips-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);flex:none;margin-right:1px}
    .cfl-task-runs{display:flex;gap:6px;overflow-x:auto;padding:9px 0 2px;scrollbar-width:none}
    .cfl-task-runs::-webkit-scrollbar{display:none}
    .cfl-task-run{flex:none;width:46px;height:46px;padding:0;border-radius:8px;overflow:hidden;cursor:pointer;
      border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center}
    .cfl-task-run img{width:100%;height:100%;object-fit:cover;display:block}
    .cfl-task-run:hover{border-color:var(--dsw-alias-border-l2)}
    .cfl-task-run.is-active{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary)}
    .cfl-task-run.is-run{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1))}
    .cfl-task-run-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
    .cfl-thumb{display:block;position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;aspect-ratio:1/1;background:var(--dsw-alias-bg-layer-2)}
    .cfl-thumb:hover{border-color:var(--dsw-alias-border-l2)}
    .cfl-thumb-media{width:100%;height:100%;object-fit:cover;display:block}
    .cfl-audio-badge{display:flex;align-items:center;justify-content:center;height:100%;font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary)}
    .cfl-params{display:flex;flex-direction:column;gap:10px}
    .cfl-param{display:grid;grid-template-columns:52px 1fr;gap:10px;align-items:start}
    .cfl-param span{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary);padding-top:1px}
    .cfl-param p{margin:0;font-size:var(--cfl-fs-body);line-height:1.6;word-break:break-word}

    /* ── 状态块 ─────────────────────────────────────────── */
    .cfl-empty{padding:26px 10px;text-align:center}
    .cfl-empty-title{font-size:var(--cfl-fs-body);font-weight:600;margin:0 0 4px}
    .cfl-empty-hint{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary);margin:0;line-height:1.6}
    .cfl-error{margin-top:12px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
    .cfl-error b{display:block;font-size:var(--cfl-fs-meta);color:var(--dsw-alias-state-error-primary);margin-bottom:3px}
    .cfl-error p{margin:0;font-size:var(--cfl-fs-meta);line-height:1.6;word-break:break-word}
    .cfl-banner{margin:0 14px 12px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-state-error-primary);font-size:var(--cfl-fs-meta)}
    .cfl-banner b{margin-right:6px;color:var(--dsw-alias-state-error-primary)}

    /* ── 工作台外壳：左导航 + 内容区 ─────────────────────── */
    .cfl-shell{flex:1;min-height:0;display:flex;overflow:hidden}
    .cfl-rail{width:176px;flex:none;display:flex;flex-direction:column;gap:2px;padding:14px 10px;border-right:1px solid var(--dsw-alias-border-l1)}
    .cfl-rail-title{font-size:11.5px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);padding:2px 10px 10px}
    .cfl-rail-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13.5px;text-align:left}
    .cfl-rail-item:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
    .cfl-rail-item.is-active{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
    .cfl-rail-item span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cfl-rail-item em{font-style:normal;font-size:11.5px;line-height:1.2;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
    .cfl-w-content{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;padding:14px;overflow:hidden}
    .cfl-w-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex:none;margin-bottom:12px}
    .cfl-w-title{font-size:16px;font-weight:600;margin:0 0 2px}
    .cfl-w-sub{font-size:12.5px;color:var(--dsw-alias-label-secondary);margin:0}
    .cfl-w-actions{display:flex;align-items:center;gap:8px}
    .cfl-chips{display:flex;gap:6px}
    .cfl-chip{height:26px;padding:0 10px;border-radius:99px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12.5px;cursor:pointer;white-space:nowrap}
    .cfl-chip.is-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
    .cfl-grid-wrap{flex:1;min-height:0;overflow:auto}
    .cfl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:12px;align-content:start;padding-bottom:4px}
    .cfl-tile{position:relative;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);cursor:pointer;text-align:left;display:block;width:100%}
    .cfl-tile:hover{border-color:var(--dsw-alias-border-l2)}
    .cfl-tile-frame{position:relative;display:block;width:100%;aspect-ratio:1/1;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
    .cfl-tile-media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
    .cfl-tile-badge{position:absolute;top:6px;left:6px;font-size:11px;padding:1px 6px;border-radius:6px;background:rgba(0,0,0,.55);color:#fff}
    .cfl-tile-meta{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;gap:1px;padding:20px 8px 6px;background:linear-gradient(to top,rgba(0,0,0,.72),rgba(0,0,0,0))}
    .cfl-tile-name{font-size:12px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cfl-tile-sub{font-size:11px;color:rgba(255,255,255,.78);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cfl-more{display:flex;justify-content:center;padding:14px 0 6px}
    .cfl-lightbox{position:absolute;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:20}
    .cfl-lightbox-body{width:min(78%,900px);max-height:86%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}
    .cfl-lightbox-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12.5px}
    .cfl-lightbox-media{width:100%;max-height:62vh;object-fit:contain;background:#000}
    .cfl-lightbox-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
    .cfl-w-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:13px}
    .cfl-w-canvas{flex:1;min-height:0;display:flex}
    .cfl-w-canvas > .cfl-col{flex:1}
    .cfl-rows{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px}
    .cfl-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer;text-align:left}
    .cfl-row:hover{border-color:var(--dsw-alias-border-l2)}
    .cfl-row-main{display:flex;flex-direction:column;min-width:0;flex:1}
    .cfl-row-title{font-size:14px}
    .cfl-row-sub{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cfl-row-tag{font-size:11.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 6px;white-space:nowrap}
    .cfl-row-time{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}

    /* ── 右侧整列停靠面板（与左栏相对的那一列）──
       语言和左栏一致：通高、直角、只有一条左边线；分区靠留白 + 一条细线，不靠卡片套卡片。 */
    .cfl-dock2{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;
      background:var(--dsw-alias-bg-base,#17191c);color:var(--dsw-alias-label-primary,#e6e8eb);
      border-left:1px solid var(--dsw-alias-border-l1,#2f3338)}
    .cfl-dock2-head{display:flex;align-items:center;gap:8px;height:40px;padding:0 14px;flex:none}
    .cfl-dock2-title{font-size:13px;font-weight:600;letter-spacing:.01em}
    .cfl-dock2-live{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa1a9);font-variant-numeric:tabular-nums}
    .cfl-dock2-tabs{flex:none;padding:0 12px 8px}
    .cfl-seg{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1e2124);flex-wrap:wrap;max-width:100%}
    .cfl-seg-btn{display:flex;align-items:center;gap:5px;height:24px;padding:0 10px;border:0;border-radius:6px;
      background:transparent;color:var(--dsw-alias-label-secondary,#9aa1a9);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
    .cfl-seg-btn:hover{color:var(--dsw-alias-label-primary,#e6e8eb)}
    .cfl-seg-btn.is-on{background:var(--dsw-alias-bg-base,#17191c);color:var(--dsw-alias-label-primary,#e6e8eb);
      box-shadow:0 1px 2px color-mix(in srgb,#000 30%,transparent)}
    .cfl-seg-num{font-size:11px;opacity:.62;font-variant-numeric:tabular-nums}
    .cfl-dock2-body{flex:1;min-height:0;overflow:auto}
    .cfl-dock2-run{flex:1;min-height:0;display:flex;flex-direction:column}
    .cfl-dock2-list{flex:none;display:flex;flex-direction:column;min-height:0;max-height:36%;
      border-top:1px solid var(--dsw-alias-border-l1,#2f3338);border-bottom:1px solid var(--dsw-alias-border-l1,#2f3338)}
    .cfl-dock2-list.is-folded{max-height:none;border-bottom:0}
    .cfl-dock2-listhead{display:flex;align-items:center;gap:8px;width:100%;height:30px;padding:0 14px;
      border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9aa1a9);
      font:inherit;font-size:12px;cursor:pointer;text-align:left;flex:none}
    .cfl-dock2-listhead:hover{color:var(--dsw-alias-label-primary,#e6e8eb)}
    .cfl-dock2-count{font-size:11px;opacity:.7;font-variant-numeric:tabular-nums}
    .cfl-dock2-fold{margin-left:auto;font-size:11px;opacity:.8}
    .cfl-dock2-listbody{flex:1;min-height:0;overflow:auto;padding:0 8px 8px}
    .cfl-dock2-detail{flex:1;min-height:0;overflow:auto}
    /* ── 视觉整理（窄列里空间稀缺，只留有信息量的东西）──
      1) 监测条那张空图表在 420px 里只是一块噪点：去掉折线，只留三行读数。
      2) 读数字改用等宽数字 + 明确的行高，扫一眼就能对比。
      3) 分区之间用留白分开，不用再套一层卡片。 */
    .cfl-dock2 .cfl-sys-spark{display:none}
    .cfl-dock2 .cfl-sys{padding:6px 14px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#2f3338)}
    .cfl-dock2 .cfl-sys-main{display:block}
    .cfl-dock2 .cfl-sys-stats{display:flex;flex-direction:column;gap:1px;margin-top:2px}
    .cfl-dock2 .cfl-sys-stat{display:flex;justify-content:space-between;gap:10px;font-size:12px;line-height:1.75;
      color:var(--dsw-alias-label-secondary,#9aa1a9);font-variant-numeric:tabular-nums}
    /* 产物做成"胶卷条"：一行横滑，不抢纵向高度；点开原地放大。
       注意：这套规则必须**全局**，不能只写在 .cfl-dock2 下面 ——
       Inspector 组件主页大屏也在用，漏了作用域就会出现"一张图被拉成一堵墙"。 */
    .cfl-film{display:flex;gap:6px;overflow-x:auto;padding:2px 0 6px;align-items:flex-start}
    .cfl-film-item{flex:0 0 72px;width:72px;height:72px;max-width:72px;max-height:72px;padding:0;
      border:1px solid var(--dsw-alias-border-l1,#2f3338);border-radius:8px;overflow:hidden;
      background:var(--dsw-alias-bg-layer-2,#26292e);cursor:zoom-in}
    .cfl-film-item:hover{border-color:var(--dsw-alias-brand-primary,#5b9dff)}
    .cfl-film-media{width:100%;height:100%;max-width:72px;max-height:72px;object-fit:cover;display:block}
    /* 原地放大：点预览图/产物后，在同一位置显示大图（不用覆盖层，窄列里最稳） */
    .cfl-preview-btn{display:block;width:100%;padding:0;border:0;background:transparent;cursor:zoom-in}
    .cfl-big{position:relative;display:flex;flex-direction:column;gap:6px}
    .cfl-big-img{width:100%;max-height:min(46vh,420px);object-fit:contain;border-radius:8px;background:#000}
    /* 收起浮在右上角：视频的播放条在底部，两者不抢位置，也不会被视频撑出可视区 */
    .cfl-big-close{position:absolute;right:8px;top:8px;z-index:2;height:26px;padding:0 12px;border-radius:6px;
      border:1px solid rgba(255,255,255,.34);background:rgba(0,0,0,.62);color:#f2f4f6;font:inherit;font-size:12px;
      cursor:pointer;backdrop-filter:blur(4px)}
    .cfl-big-close:hover{background:rgba(0,0,0,.82);border-color:#fff}
    .cfl-big-name{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa1a9);
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cfl-big-bar{display:none}
    /* 灯箱样式保留但不再使用（改成原地放大，避免覆盖层被裁） */
    .cfl-lb{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,.84);cursor:zoom-out;padding:24px}
    .cfl-lb-img{max-width:100%;max-height:calc(100% - 48px);object-fit:contain;border-radius:6px;
      box-shadow:0 24px 60px rgba(0,0,0,.5)}
    .cfl-lb-bar{position:absolute;left:0;right:0;bottom:0;height:42px;display:flex;align-items:center;gap:10px;
      padding:0 14px;background:rgba(0,0,0,.55);color:#e6e8eb;font-size:12px}
    .cfl-lb-name{opacity:.82;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cfl-lb-close{margin-left:auto;height:26px;padding:0 12px;border-radius:6px;border:1px solid rgba(255,255,255,.3);
      background:transparent;color:#e6e8eb;font-size:12px;cursor:pointer}
    .cfl-lb-close:hover{background:rgba(255,255,255,.12)}
    .cfl-dock2 .cfl-thumbs,.cfl-dock2 .cfl-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .cfl-dock2 .cfl-tile-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
      line-height:1.35;word-break:break-all}
    .cfl-dock2 .cfl-w-content{padding:4px 12px 12px}
    .cfl-dock2 .cfl-w-head{padding:6px 2px 10px;gap:8px}
    .cfl-dock2 .cfl-w-title{font-size:13px;font-weight:600;margin:0}
    .cfl-dock2 .cfl-w-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa1a9);margin:2px 0 0}
    /* 停在窄列里时，预览图必须限高：否则一张竖图吃掉半屏，下面的产物和参数全被挤出去 */
    .cfl-dock2 .cfl-preview-media{max-height:180px;width:100%;object-fit:contain;border-radius:8px}
    /* 选中项：一条 2px 强调边 + 略深的底，扫一眼就知道在看哪一条 */
    .cfl-dock2 .cfl-run{position:relative;border-radius:8px}
    .cfl-dock2 .cfl-run.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b9dff) 10%,transparent)}
    .cfl-dock2 .cfl-run.is-active::before{content:'';position:absolute;left:0;top:6px;bottom:6px;width:2px;border-radius:2px;
      background:var(--dsw-alias-brand-primary,#5b9dff)}
    /* 列表高度给到 44%，行距收紧一点，一屏多看两条 */
    .cfl-dock2-list{max-height:44%}
    .cfl-dock2 .cfl-thumbs{grid-template-columns:repeat(2,minmax(0,1fr))}
    /* ── 抽屉（可拖动、可缩放；右侧栏不可用时的退路）──
       注意背景色都带兜底值：shell.overlay 里拿不到 DSH 的主题变量，
       只写 var(--dsw-alias-bg-base) 会解析失败 → 面板变半透明，底下的对话文字透出来。 */
    .cfl-float{position:absolute;z-index:41;pointer-events:auto;display:flex;flex-direction:column;
      background:var(--dsw-alias-bg-base,#17191c);border:1px solid var(--dsw-alias-border-l2,#3d444b);border-radius:12px;
      box-shadow:0 18px 48px color-mix(in srgb,#000 38%,transparent),0 2px 8px color-mix(in srgb,#000 24%,transparent);
      overflow:hidden;color:var(--dsw-alias-label-primary,#e6e8eb)}
    .cfl-float-bar{display:flex;align-items:center;gap:8px;height:44px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#2f3338);flex:none;background:var(--dsw-alias-bg-layer-1,#1e2124);cursor:move;user-select:none;touch-action:none}
    .cfl-float-body{background:var(--dsw-alias-bg-base,#17191c)}
    .cfl-float-title{font-size:13px;font-weight:600;white-space:nowrap}
    .cfl-float-meta{font-size:12px;color:var(--dsw-alias-label-secondary);margin-left:auto;margin-right:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cfl-float-body{flex:1;min-height:0;overflow:hidden;display:flex}
    .cfl-float-body > .cfl-root{flex:1}
    .cfl-float-grip{position:absolute;left:0;top:0;bottom:0;width:5px;cursor:ew-resize}
    .cfl-float-grip:hover{background:var(--dsw-alias-border-l2)}
    /* 铺满视口的一层：只用来给里面的东西定位，本身不吃点击。
       shell.overlay 的容器是 0×0 且贴原点，所以外层尺寸一律用 vw/vh，
       内部再靠 flex 推位置——这样不会算到 0 上。 */
    .cfl-layer{position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:60;
      display:flex;align-items:flex-end;justify-content:flex-end;padding:16px;
      pointer-events:none;box-sizing:border-box}
    .cfl-layer > *{pointer-events:auto}
    /* 右下角改大小 */
    .cfl-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;
      background:linear-gradient(135deg,transparent 46%,var(--dsw-alias-border-l2) 46%,var(--dsw-alias-border-l2) 56%,transparent 56%,transparent 68%,var(--dsw-alias-border-l2) 68%,var(--dsw-alias-border-l2) 78%,transparent 78%)}
    .cfl-resize:hover{background:linear-gradient(135deg,transparent 46%,var(--dsw-alias-brand-primary) 46%,var(--dsw-alias-brand-primary) 56%,transparent 56%,transparent 68%,var(--dsw-alias-brand-primary) 68%,var(--dsw-alias-brand-primary) 78%,transparent 78%)}
    /* 入口按钮的定位壳：绝对定位到 (x,y)，里面只放按钮和 hover 才出现的 × */
    .cfl-pill-wrap{position:absolute;pointer-events:auto}
    .cfl-pill-wrap .cfl-dock{width:100%;height:100%;justify-content:center;cursor:grab;touch-action:none;user-select:none}
    .cfl-pill-wrap .cfl-dock:active{cursor:grabbing}
    .cfl-pill-hide{position:absolute;right:-7px;top:-7px;width:16px;height:16px;padding:0;line-height:14px;
      border:1px solid var(--dsw-alias-border-l2,#3d444b);border-radius:50%;background:var(--dsw-alias-bg-base,#17191c);
      color:var(--dsw-alias-label-secondary,#9aa1a9);font-size:11px;cursor:pointer;opacity:.6;transition:opacity .12s ease}
    .cfl-pill-wrap:hover .cfl-pill-hide{opacity:1}
    .cfl-pill-hide:hover{color:var(--dsw-alias-state-error-primary,#f85149);border-color:var(--dsw-alias-state-error-primary,#f85149)}
    /* 收起后的入口：右下角一张小卡片。 */
    .cfl-dock{display:flex;align-items:center;gap:8px;height:38px;padding:0 14px;
      border:1px solid var(--dsw-alias-border-l2);border-radius:19px;
      background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
      font-size:13px;font-weight:500;line-height:1;cursor:pointer;appearance:none;
      box-shadow:0 6px 22px color-mix(in srgb,#000 26%,transparent);
      transition:border-color .12s ease,transform .12s ease,background .12s ease}
    .cfl-dock:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);transform:translateY(-1px)}
    .cfl-dock:active{transform:translateY(0)}
    .cfl-dock:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
    .cfl-dock-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
    .cfl-dock-label{white-space:nowrap}
    .cfl-dock-meta{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary);white-space:nowrap}
    .cfl-dock.is-run{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 50%,var(--dsw-alias-border-l2))}
    .cfl-dock.is-run .cfl-dock-dot{background:var(--dsw-alias-brand-primary);animation:cfl-pulse 1.3s ease-in-out infinite}
    .cfl-dock.is-off .cfl-dock-dot{background:var(--dsw-alias-state-error-primary)}
    .cfl-root.is-compact{min-height:0}
    .cfl-main.is-compact{display:flex;flex-direction:column;padding:0;gap:0;overflow:hidden}
    .cfl-main.is-compact .cfl-col-inspector{padding-right:0;gap:0}
    /* 停靠栏里不要"卡片套卡片"：改成原生侧栏那种分隔线 + 通栏内容 */
    .cfl-float .cfl-card{border:0;border-radius:0;background:transparent}
    .cfl-float .cfl-card + .cfl-card{border-top:1px solid var(--dsw-alias-border-l1)}
    .cfl-float .cfl-card-head{padding:12px 14px 8px}
    .cfl-float .cfl-card-body{padding:0 14px 14px}
    .cfl-float .cfl-preview-media{width:100%;max-height:38vh;border-radius:0;object-fit:contain;background:var(--dsw-alias-bg-layer-2);display:block}
    .cfl-float .cfl-preview-blank{border-radius:0;height:180px}
    .cfl-float .cfl-thumbs{gap:6px}

    /* ── 系统监控条（显存/内存/CPU + 折线 + 看门狗）──
       放停靠栏顶部：不滚走，随时能看出"能不能跑、会不会 OOM"。
       只在真的出问题时上色，正常状态是灰的——装饰色不抢图。 */
    .cfl-sys{flex:none;padding:8px 12px 9px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
    .cfl-sys-main{display:flex;align-items:stretch;gap:12px}
    .cfl-sys-spark{flex:1;min-width:60px;height:34px;display:block;overflow:visible}
    .cfl-sys-spark.is-empty{background:linear-gradient(var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-2));border-radius:4px;opacity:.5}
    .cfl-spark-base{stroke:var(--dsw-alias-border-l1);stroke-width:1;vector-effect:non-scaling-stroke}
    .cfl-spark-mid{stroke:var(--dsw-alias-border-l1);stroke-width:1;stroke-dasharray:3 4;opacity:.75;vector-effect:non-scaling-stroke}
    .cfl-spark-area{fill:var(--dsw-alias-brand-primary);opacity:.18;stroke:none}
    .cfl-spark-vram{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:1.7;stroke-linejoin:round;vector-effect:non-scaling-stroke}
    .cfl-spark-cpu{fill:none;stroke:var(--dsw-alias-label-secondary);stroke-width:1.1;stroke-dasharray:3 2;opacity:.8;stroke-linejoin:round;vector-effect:non-scaling-stroke}
    .cfl-sys-stats{flex:none;display:flex;flex-direction:column;justify-content:center;gap:2px}
    .cfl-sys-stat{display:flex;align-items:baseline;gap:9px;font-size:12px;line-height:1.38}
    .cfl-sys-stat em{font-style:normal;color:var(--dsw-alias-label-secondary);width:28px;flex:none;font-size:11.5px}
    .cfl-sys-stat b{font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);white-space:nowrap}
    .cfl-sys-stat.is-warn b{color:var(--dsw-alias-state-warn-primary)}
    .cfl-sys-note{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
    .cfl-sys-alert{display:flex;align-items:baseline;gap:7px;margin-top:7px;font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
    .cfl-sys-alert b{flex:none;color:var(--dsw-alias-state-error-primary);font-weight:600}
    .cfl-sys.is-warn .cfl-sys-alert b{color:var(--dsw-alias-state-warn-primary)}
    .cfl-sys.is-down .cfl-sys-spark{opacity:.4}
    .cfl-sys.is-down .cfl-sys-stat b{color:var(--dsw-alias-state-error-primary)}

    @keyframes cfl-pulse{0%,100%{opacity:1}50%{opacity:.35}}
    @keyframes cfl-slide{0%{transform:translateX(-10%)}50%{transform:translateX(160%)}100%{transform:translateX(-10%)}}

    @media (max-width:1180px){
      .cfl-main{grid-template-columns:264px minmax(0,1fr) 320px}
    }
    @media (max-width:960px){
      .cfl-main{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto auto;overflow:auto}
      .cfl-col-timeline{max-height:260px}
      .cfl-col-canvas{min-height:320px}
      .cfl-col-inspector{overflow:visible}
    }
    ` )
    }

    // ─── 60-apply.js ───────────────────────────────────────────────────
    // 60-apply.js — 三个入口：左栏（主页大屏）、右侧整列停靠（主形态）、右下角卡片（入口）。
    //
    // 2026-11-05 定案（前后反复了三次，结论写死在这里）：
    //  · 工作台是**跟左栏相对的一整列**，不是飘在对话上的卡片。
    //    理由：它要长期开着、要能扫列表、要能看大图；浮窗会挡住对话，也不像个工具。
    //  · 那一列用 DSH 自己的右侧栏（Ctrl+Alt+B）——它是唯一能让对话区让出位置、
    //    而不是被盖住的地方。正文用 DockPanel（执行/产物库/工作流三档都在）。
    //  · 右下角卡片只是**入口**：它去调 openTab；万一右侧栏调不动，才退化成抽屉。
    //    入口的可见性永远不由"另一个还没验证成功的动作"决定（这条踩过坑）。
    //
    // 右侧栏注册的两个硬约束（都有代码依据，别再犯）：
    //  1) id 全局唯一，重复注册会抛 "already registered"，而 DSH 热重载不重建注册表
    //     → 注册失败不影响已有那个 tab，忽略即可。
    //  2) guide 条目的 title / description 必须是**函数**（lib/client.js:624/618），
    //     传字符串会让「开始」整页渲染失败 → 一片空白。这里干脆不注册 guide。

    const TAB_ID = '@local/dsh-comfy-live/workbench'
    const TAB_KIND = 'comfy'

    let TAB_DBG = 'pending'

    function registerTab(ctx, attempt) {
      const get = typeof ctx.get === 'function' ? ctx.get.bind(ctx) : null
      const tabs = get ? get('sidebarRightTabs') : null
      if (!tabs || typeof tabs.register !== 'function') {
        if (attempt < 10) {
          setTimeout(() => { try { registerTab(ctx, attempt + 1) } catch { /* ignore */ } }, 400)
          return
        }
        TAB_DBG = 'no-service'
        diag('tab.register', { ok: false, error: 'no-tabs-service' })
        return
      }
      try {
        tabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => 'Comfy 工作台',
          keepMounted: true,
        })
        TAB_DBG = 'ok'
        diag('tab.register', { ok: true, attempt })
      } catch (e) {
        // 已经注册过（热重载）＝ 上一份定义还在用，不算失败
        TAB_DBG = 'exists'
        diag('tab.register', { ok: false, error: String((e && e.message) || e).slice(0, 90) })
      }
      try {
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
        }, DockBoundary))
        diag('tab.body', { ok: true })
      } catch (e) {
        diag('tab.body', { ok: false, error: String((e && e.message) || e).slice(0, 90) })
      }
    }

    /** 打开右侧那一列；返回 true 表示交给了 DSH 的右侧栏 */
    function openWorkbench(ctx) {
      try {
        const get = typeof ctx.get === 'function' ? ctx.get.bind(ctx) : null
        const right = get ? get('sidebarRight') : null
        if (right && typeof right.openTab === 'function') {
          // 栏是收着的就先把栏展开：用户点按钮就是要看见工作台，
          // 不能只弹一句"请按 Ctrl+Alt+B"再让他自己来（之前就是这个行为）。
          try {
            const expanded = typeof right.isExpanded === 'function' ? right.isExpanded() : true
            if (!expanded && typeof right.toggleExpanded === 'function') {
              right.toggleExpanded()
              diag('open.expand', { ok: true })
            }
          } catch { /* 展开失败也继续试 openTab */ }
          right.openTab(TAB_KIND)
          diag('open.tab', { ok: true })
          return true
        }
        diag('open.tab', { ok: false, error: 'no-openTab' })
      } catch (e) {
        diag('open.tab', { ok: false, error: String((e && e.message) || e).slice(0, 90) })
      }
      return false
    }

    /**
     * 安全注册：DSH 版本之间 slot 名字会变（新机器上 0.2.0 就是这种情况）。
     * 任何一处 inject/register 抛错，都只应该"少一个入口"，绝不能让整个 apply 失败——
     * apply 一失败，面板就完全不出现，而且界面上不会说为什么。所以逐个包起来，并记日志。
     */
    function trySlot(ctx, slot, opts, Comp) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
          diag('slot.skip', { slot, why: 'no-slots' })
          return false
        }
        ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, ...opts }, Comp))
        diag('slot.ok', { slot })
        return true
      } catch (e) {
        diag('slot.fail', { slot, error: String((e && e.message) || e).slice(0, 120) })
        return false
      }
    }

    function apply(ctx) {
      UI_CTX = ctx
      try { diagInstall() } catch { /* ignore */ }
      let registered = 0
      try {
        const get = typeof ctx.get === 'function' ? ctx.get.bind(ctx) : null
        diag('apply', {
          slots: !!(ctx && ctx.slots),
          tabs: !!(get && get('sidebarRightTabs')),
          layout: !!(ctx && ctx.layout),
          href: String(location.href).replace(/[?].*/, ''),
        })
      } catch { /* ignore */ }

      // 左栏入口：主页面板（大屏看画布/大图时用）
      if (trySlot(ctx, 'sidebar.panellist', { id: PANEL_ID, order: 30, label: 'Comfy 工作台' }, PanelIcon)) registered++

      if (trySlot(ctx, 'main', { key: PANEL_ID }, ComfyPanelBoundary)) registered++

      // 右侧整列停靠（主形态）
      try { registerTab(ctx, 0) } catch { /* ignore */ }

      // 右下角卡片（入口 / 退路）
      try {
        const FloatPanel = makeFloatPanel(ctx, () => openWorkbench(ctx))
        if (trySlot(ctx, 'shell.overlay', { id: 'comfy-live-float', order: 55, label: 'Comfy 工作台入口' }, FloatPanel)) registered++
      } catch { /* 没有 shell.overlay 也还有左栏入口 */ }

      // 一个入口都没注册上，说明这台机器的 DSH 版本和插件对不上：
      // 至少把事实写进诊断日志，而不是"面板没出现、什么都没说"。
      try { diag('apply.done', { registered, slots: ['sidebar.panellist', 'main', 'shell.overlay'] }) } catch { /* ignore */ }

      try {
        boot()
      } catch { /* 数据流起不来也不影响手动点开 */ }
    }


    return { inject: ['slots', 'layout'], apply }
  },
})
