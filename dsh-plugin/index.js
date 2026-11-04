/**
 * Comfy 实时台 — Host 半。
 *
 * 解决的三件事（和旧看板的区别）：
 *  1. 实时：直接订阅 ComfyUI 自己的 /ws（execution_start / executing / progress /
 *     executed / 预览帧），所以不管任务是谁提交的都会实时出现在面板里。
 *  2. 同源：路由挂在 DSH 自己的 HTTP 服务上（/comfy-live/*），没有第二个端口、
 *     没有 CORS、不需要手动起服务，DSH 活着面板就活着。
 *  3. 可回看：每次执行的 API 图在开始那一刻就拆出来、落盘到 runs/live/，
 *     并转成 UI 格式写进 ComfyUI 的工作流列表，事后点得开。
 */
import { randomBytes } from 'node:crypto'
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { URL } from 'node:url'

export const name = 'dsh-comfy-live'
export const inject = ['webServer', 'tools']
export { ComfySocket }

const PREFIX = '/comfy-live'
const MAX_RUNS = 60
const MAX_OUTPUTS_PER_RUN = 48

// ---------------------------------------------------------------- tiny ws client

class ComfySocket {
  constructor(url, handlers) {
    this.url = url
    this.h = handlers
    this.sock = null
    this.disposed = false
    this.buf = Buffer.alloc(0)
    this.frag = null
    this.fragOp = 0
    this.retry = 0
    this.reconnectTimer = null
    this.pingTimer = null
    this.lastPong = 0
    // 每次连接一个代号：旧连接迟到的 close/error 绝不能把新连接顶掉。
    // （之前的 bug：两次并发 connect 用同一个 sid，其中一个断开时 ComfyUI 把
    //   sockets[sid] 整个 pop 掉，于是看起来连着、其实收不到任何事件。）
    this.gen = 0
  }

  connect() {
    if (this.disposed) return
    this.#teardown()
    const gen = ++this.gen
    let u
    try { u = new URL(this.url) } catch { return }
    const secure = u.protocol === 'wss:'
    const req = httpRequest({
      host: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    })
    req.on('upgrade', (res, socket) => {
      if (this.disposed || gen !== this.gen) { socket.destroy(); return }
      this.sock = socket
      this.retry = 0
      this.buf = Buffer.alloc(0)
      this.lastPong = Date.now()
      socket.setNoDelay(true)
      socket.on('data', (chunk) => { if (gen === this.gen) this.#onData(chunk) })
      socket.on('error', () => { if (gen === this.gen) this.#drop() })
      socket.on('close', () => { if (gen === this.gen) this.#drop() })
      this.pingTimer = setInterval(() => this.#heartbeat(gen), 15000)
      if (this.pingTimer.unref) this.pingTimer.unref()
      this.h.open && this.h.open()
    })
    req.on('response', (res) => { res.resume(); if (gen === this.gen) this.#drop() })
    req.on('error', () => { if (gen === this.gen) this.#drop() })
    req.end()
  }

  /** 连接还在、但对面已经不认这条连接时，靠 pong 判活并重连 */
  #heartbeat(gen) {
    if (gen !== this.gen) return
    if (Date.now() - this.lastPong > 45000) {
      // 发过 ping 却一直没 pong：几乎一定是半开连接，直接重建
      this.#drop()
      return
    }
    this.#send(0x9, Buffer.alloc(0))
  }

  /** 提交前确保有一条活的连接（sid 才会重新登记到 ComfyUI 的 sockets 里） */
  ensure() {
    if (this.disposed) return
    if (this.sock && !this.sock.destroyed) return
    this.connect()
  }

  #teardown() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.sock) {
      const s = this.sock
      this.sock = null
      try { s.destroy() } catch { /* ignore */ }
    }
  }

  #drop() {
    this.#teardown()
    this.buf = Buffer.alloc(0)
    this.frag = null
    this.h.close && this.h.close()
    if (this.disposed) return
    if (this.reconnectTimer) return
    this.retry = Math.min(this.retry + 1, 8)
    const wait = Math.min(1000 * 2 ** (this.retry - 1), 8000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, wait)
    if (this.reconnectTimer.unref) this.reconnectTimer.unref()
  }

  #send(op, payload) {
    const socket = this.sock
    if (!socket || socket.destroyed) return
    const len = payload.length
    const mask = randomBytes(4)
    let header
    if (len < 126) {
      header = Buffer.alloc(6)
      header[1] = 0x80 | len
    } else if (len < 65536) {
      header = Buffer.alloc(8)
      header[1] = 0x80 | 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(14)
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    header[0] = 0x80 | op
    mask.copy(header, header.length - 4)
    const body = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3]
    try { socket.write(Buffer.concat([header, body])) } catch { /* reconnect will handle */ }
  }

  #onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    for (;;) {
      if (this.buf.length < 2) return
      const b0 = this.buf[0]
      const b1 = this.buf[1]
      const fin = (b0 & 0x80) !== 0
      const op = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let off = 2
      if (len === 126) {
        if (this.buf.length < 4) return
        len = this.buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (this.buf.length < 10) return
        const big = this.buf.readBigUInt64BE(2)
        if (big > BigInt(64 * 1024 * 1024)) { this.#drop(); return }
        len = Number(big)
        off = 10
      }
      let maskKey = null
      if (masked) {
        if (this.buf.length < off + 4) return
        maskKey = this.buf.subarray(off, off + 4)
        off += 4
      }
      if (this.buf.length < off + len) return
      let payload = this.buf.subarray(off, off + len)
      this.buf = this.buf.subarray(off + len)
      if (masked && maskKey) {
        const p = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) p[i] = payload[i] ^ maskKey[i & 3]
        payload = p
      }
      if (op === 0x0) {
        if (this.frag) {
          this.frag.push(payload)
          if (fin) {
            const all = Buffer.concat(this.frag)
            const o = this.fragOp
            this.frag = null
            this.#message(o, all)
          }
        }
        continue
      }
      if (op === 0x8) { this.disposed ? null : this.#drop(); return }
      if (op === 0x9) { this.#send(0xa, payload); continue }
      if (op === 0xa) { this.lastPong = Date.now(); continue }
      if (!fin) { this.frag = [payload]; this.fragOp = op; continue }
      this.#message(op, payload)
    }
  }

  #message(op, buf) {
    if (op === 0x1) {
      try { this.h.message && this.h.message(JSON.parse(buf.toString('utf8'))) } catch { /* ignore malformed */ }
    } else if (op === 0x2) {
      this.h.binary && this.h.binary(buf)
    }
  }

  dispose() {
    this.disposed = true
    this.gen++
    this.#teardown()
  }
}

// ---------------------------------------------------------------- api -> ui graph

const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN'])
const isWidgetSpec = (spec) => {
  const t = spec && spec[0]
  return Array.isArray(t) || WIDGET_TYPES.has(t)
}
const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number'

/** 把 API 格式（提交用）转成 ComfyUI 前端能直接打开的 UI 格式 */
function apiToUiGraph(api, info, meta = {}) {
  const ids = Object.keys(api || {})
  if (!ids.length) return null
  const parents = Object.fromEntries(ids.map((id) => [id, []]))
  for (const [id, n] of Object.entries(api)) {
    for (const v of Object.values(n.inputs || {})) if (isLink(v)) parents[id].push(v[0])
  }
  const depth = {}
  for (const id of ids) {
    const walk = (cur, seen) => {
      if (depth[cur] !== undefined) return depth[cur]
      if (seen.has(cur)) return 0
      seen.add(cur)
      let d = 0
      for (const p of parents[cur] || []) d = Math.max(d, walk(p, seen) + 1)
      depth[cur] = d
      return d
    }
    walk(id, new Set())
  }
  const columns = {}
  for (const id of ids) (columns[depth[id]] ||= []).push(id)
  const NODE_W = 320
  const COL_GAP = 90
  const pos = {}
  for (const [dStr, col] of Object.entries(columns)) {
    const d = Number(dStr)
    col.sort((a, b) => Number(a) - Number(b)).forEach((id, i) => { pos[id] = [60 + d * (NODE_W + COL_GAP), 80 + i * 190] })
  }

  const linkInputs = {}
  for (const [id, n] of Object.entries(api)) {
    const def = (info && info[n.class_type]) || {}
    const all = [...Object.entries(def.input?.required || {}), ...Object.entries(def.input?.optional || {})]
    const list = []
    for (const [name, spec] of all) {
      if (isWidgetSpec(spec)) continue
      list.push({ name, type: String(Array.isArray(spec?.[0]) ? 'COMBO' : spec?.[0] || '*') })
    }
    for (const [name, v] of Object.entries(n.inputs || {})) {
      if (isLink(v) && !list.some((x) => x.name === name)) list.push({ name, type: '*' })
    }
    linkInputs[id] = list
  }

  const links = []
  const linkMap = new Map()
  let linkId = 0
  for (const [id, n] of Object.entries(api)) {
    const list = linkInputs[id]
    for (const [name, v] of Object.entries(n.inputs || {})) {
      if (!isLink(v)) continue
      const slot = list.findIndex((x) => x.name === name)
      const lid = ++linkId
      linkMap.set(`${id}:${name}`, lid)
      links.push([lid, Number(v[0]), v[1], Number(id), slot < 0 ? 0 : slot, list[slot]?.type || ''])
    }
  }

  const nodes = []
  for (const [id, n] of Object.entries(api)) {
    const cls = n.class_type
    const def = (info && info[cls]) || {}
    const all = [...Object.entries(def.input?.required || {}), ...Object.entries(def.input?.optional || {})]
    const inputs = []
    const widgets = []
    for (const [name, spec] of all) {
      const v = n.inputs?.[name]
      if (isWidgetSpec(spec)) {
        widgets.push(v !== undefined ? v : (spec?.[1]?.default ?? null))
      } else {
        const lid = v !== undefined && isLink(v) ? linkMap.get(`${id}:${name}`) : null
        inputs.push({ name, type: String(Array.isArray(spec?.[0]) ? 'COMBO' : spec?.[0] || '*'), link: lid ?? null })
      }
    }
    for (const [name, v] of Object.entries(n.inputs || {})) {
      if (!isLink(v)) continue
      if (inputs.some((x) => x.name === name)) continue
      inputs.push({ name, type: '*', link: linkMap.get(`${id}:${name}`) ?? null })
    }
    if (cls === 'KSampler' || cls === 'KSamplerAdvanced') {
      const at = widgets.length > 1 ? 1 : widgets.length
      widgets.splice(at, 0, 'randomize')
    }
    const outputs = (def.output || []).map((type, i) => ({
      name: (def.output_name || [])[i] || type,
      type,
      links: links.filter((l) => l[1] === Number(id) && l[2] === i).map((l) => l[0]),
      slot_index: i,
    }))
    nodes.push({
      id: Number(id),
      type: cls,
      pos: pos[id],
      size: [NODE_W, 60 + widgets.length * 26 + inputs.length * 24],
      flags: {},
      order: Number(id),
      mode: 0,
      inputs,
      outputs,
      properties: { 'Node name for S&R': cls },
      widgets_values: widgets,
    })
  }
  return {
    last_node_id: Math.max(...nodes.map((n) => n.id)),
    last_link_id: linkId,
    nodes,
    links,
    groups: [],
    config: {},
    extra: { ds: { scale: 0.85, offset: [0, 0] }, comfyforge: meta },
    version: 0.4,
  }
}

// ---------------------------------------------------------------- helpers

function pickPromptText(api) {
  for (const n of Object.values(api || {})) {
    const t = n?.inputs?.text
    if (typeof t === 'string' && t.trim()) return t.trim()
  }
  return ''
}

function shortId(id) { return String(id || '').slice(0, 8) }

/**
 * ComfyUI 的产物不止 images：VHS/H3 这类节点把视频放在 gifs / videos / audio 里。
 * 面板要能把它们播出来，所以这里统一收成一份清单。
 */
function collectOutputMedia(out) {
  const items = []
  const buckets = [['images', 'image'], ['gifs', 'animation'], ['videos', 'video'], ['audio', 'audio']]
  for (const [key, bucketKind] of buckets) {
    for (const x of (out && out[key]) || []) {
      if (!x || !x.filename) continue
      // 按扩展名定种类：VHS 会把 mp4 塞在 gifs 桶里，只看桶名会判错
      const name = String(x.filename).toLowerCase()
      const kind = /\.(mp4|webm|mov|mkv)$/.test(name) ? 'video'
        : /\.(gif|webp)$/.test(name) ? 'animation'
          : /\.(wav|mp3|flac|ogg)$/.test(name) ? 'audio'
            : bucketKind === 'video' ? 'video' : bucketKind === 'audio' ? 'audio' : 'image'
      items.push({ filename: x.filename, subfolder: x.subfolder || '', type: x.type || 'output', kind })
    }
  }
  return items
}


function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('提交体过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}


function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function extOfType(t) { return t === 'temp' ? 'temp' : t === 'input' ? 'input' : 'output' }

function mimeOf(name) {
  const i = String(name).lastIndexOf('.')
  const ext = i >= 0 ? String(name).slice(i).toLowerCase() : ''
  switch (ext) {
    case '.png': return 'image/png'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.mp4': return 'video/mp4'
    case '.webm': return 'video/webm'
    case '.mov': return 'video/quicktime'
    case '.mp3': return 'audio/mpeg'
    case '.wav': return 'audio/wav'
    default: return 'application/octet-stream'
  }
}

/** 只读 PNG 的 IHDR 拿宽高（产物库要显示尺寸，但不该为此解码整张图） */
function pngSize(file) {
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(24)
    readSync(fd, buf, 0, 24, 0)
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  } catch {
    return null
  } finally {
    if (fd >= 0) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}


// ---------------------------------------------------------------- hub

class Hub {
  constructor(options) {
    this.opts = options
    this.comfy = String(options.comfyUrl || 'http://127.0.0.1:8188').replace(/\/$/, '')
    this.runs = new Map()
    this.order = []
    this.clients = new Set()
    this.connected = false
    this.info = null
    this.infoAt = 0
    this.socket = null
    this.saveDir = join(options.projectRoot || '', 'runs', 'live')
    this.workflowDir = options.comfyRoot ? join(options.comfyRoot, 'user', 'default', 'workflows') : ''
    // 产物库要直接扫 ComfyUI 的 output 目录：很多图不是经这个面板出的，也得能看见
    this.outputDir = options.comfyRoot ? join(options.comfyRoot, 'output') : ''
    this.templateDir = join(options.projectRoot || '.', 'workflows')
  }

  // -- lifecycle

  start() {
    try { mkdirSync(this.saveDir, { recursive: true }) } catch { /* 落盘失败不挡住实时 */ }
    const clientId = `dsh-comfy-live-${randomBytes(4).toString('hex')}`
    this.clientId = clientId
    this.socket = new ComfySocket(`${this.comfy.replace(/^http/, 'ws')}/ws?clientId=${clientId}`, {
      open: () => { this.connected = true; this.broadcast({ t: 'conn', connected: true }) },
      close: () => { this.connected = false; this.broadcast({ t: 'conn', connected: false }) },
      message: (msg) => this.onEvent(msg),
      binary: (buf) => this.onPreview(buf),
    })
    this.socket.connect()
    this.seedHistory().catch(() => { /* 历史拿不到不影响实时 */ })
    this.historyTimer = setInterval(() => {
      this.ingestHistory(10).catch(() => { /* 下一轮再说 */ })
    }, 8000)
    if (this.historyTimer.unref) this.historyTimer.unref()
  }

  dispose() {
    if (this.socket) this.socket.dispose()
    if (this.historyTimer) clearInterval(this.historyTimer)
    for (const res of this.clients) { try { res.end() } catch { /* ignore */ } }
    this.clients.clear()
  }

  /**
   * 把 DSH 的 origin 写进 .cache，MCP 侧据此把提交转到本面板。
   * 拿不到就跳过：MCP 会退回直连 ComfyUI（仍然能跑，只是不实时）。
   */
  noteOrigin(origin) {
    if (!origin || origin === this.origin) return
    this.origin = origin
    try {
      mkdirSync(join(this.opts.projectRoot, '.cache'), { recursive: true })
      writeFileSync(join(this.opts.projectRoot, '.cache', 'comfy-live-endpoint.json'),
        JSON.stringify({ origin, at: Date.now(), version: 1 }, null, 2), 'utf8')
    } catch { /* ignore */ }
  }


  // -- http helpers

  async json(path, timeout = 15000) {
    const r = await fetch(this.comfy + path, { signal: AbortSignal.timeout(timeout) })
    if (!r.ok) throw new Error(`ComfyUI ${path} -> HTTP ${r.status}`)
    return r.json()
  }

  async objectInfo() {
    if (this.info && Date.now() - this.infoAt < 300000) return this.info
    try {
      this.info = await this.json('/object_info', 60000)
      this.infoAt = Date.now()
    } catch {
      this.info = this.info || {}
    }
    return this.info
  }

  // -- run bookkeeping

  createRun(id, extra = {}) {
    if (this.runs.has(id)) return this.runs.get(id)
    const run = {
      id,
      label: '',
      status: 'running',
      source: 'live',
      startedAt: Date.now(),
      endedAt: null,
      graph: null,
      nodeStates: {},
      currentNode: null,
      progress: null,
      preview: null,
      outputs: [],
      error: null,
      template: extra.template || '',
      queued: false,
    }
    this.runs.set(id, run)
    this.order.push(id)
    this.trim()
    this.broadcast({ t: 'run:new', run: this.summary(run) })
    this.attachGraph(run).catch(() => { /* 拿不到图也不影响状态流 */ })
    return run
  }

  async attachGraph(run) {
    if (run.graph || run._graphLoading) return
    run._graphLoading = true
    let graph = null
    for (let attempt = 0; attempt < 4 && !graph; attempt++) {
      try {
        const q = await this.json('/queue')
        const items = [...(q.queue_running || []), ...(q.queue_pending || [])]
        for (const item of items) {
          if (item && item[1] === run.id) { graph = item[2]; break }
        }
      } catch { /* retry */ }
      if (!graph) {
        try {
          const h = await this.json(`/history/${run.id}`)
          graph = h?.[run.id]?.prompt?.[2] || null
        } catch { /* retry */ }
      }
      if (!graph) await new Promise((r) => setTimeout(r, 250))
    }
    // 无论成功与否都要放开这个标记，否则一次失败会让这次执行永远取不到图
    run._graphLoading = false
    if (!graph || this.runs.get(run.id) !== run) return
    run.graph = graph
    run.label = (pickPromptText(graph) || Object.values(graph).map((n) => n.class_type).slice(0, 2).join(' → ') || '执行').slice(0, 72)
    run.nodeIds = Object.keys(graph)
    this.broadcast({ t: 'run:graph', id: run.id, graph, label: run.label })
    this.persist(run)
    this.saveUiWorkflow(run).catch(() => { /* 写不进 ComfyUI 不影响实时 */ })
    this.broadcast({ t: 'run:summary', run: this.summary(run) })
  }

  saveUiWorkflow(run) {
    if (!this.opts.saveWorkflow || !this.workflowDir || !run.graph) return Promise.resolve()
    return this.objectInfo().then((info) => {
      const ui = apiToUiGraph(run.graph, info, { name: `ComfyForge-${shortId(run.id)}`, title: run.label })
      if (!ui) return
      mkdirSync(this.workflowDir, { recursive: true })
      const name = `ComfyForge-${stamp(new Date(run.startedAt))}-${shortId(run.id)}.json`
      writeFileSync(join(this.workflowDir, name), JSON.stringify(ui, null, 2), 'utf8')
      run.savedWorkflow = name
    })
  }

  persist(run) {
    if (!this.opts.projectRoot) return
    try {
      mkdirSync(this.saveDir, { recursive: true })
      const body = {
        id: run.id,
        label: run.label,
        status: run.status,
        source: run.source,
        startedAt: new Date(run.startedAt).toISOString(),
        endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : null,
        durationMs: run.endedAt ? run.endedAt - run.startedAt : null,
        graph: run.graph,
        outputs: run.outputs,
        error: run.error,
        savedWorkflow: run.savedWorkflow || null,
      }
      writeFileSync(join(this.saveDir, `${run.id}.json`), JSON.stringify(body, null, 2), 'utf8')
    } catch { /* ignore */ }
  }

  trim() {
    while (this.order.length > MAX_RUNS) {
      const id = this.order.shift()
      this.runs.delete(id)
    }
  }

  summary(run) {
    return {
      id: run.id,
      label: run.label,
      status: run.status,
      source: run.source,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: run.endedAt ? run.endedAt - run.startedAt : null,
      progress: run.progress,
      currentNode: run.currentNode,
      nodeCount: run.nodeIds ? run.nodeIds.length : 0,
      outputs: run.outputs.length,
      thumb: (() => {
        // 缩略图只给静图/动图：视频塞进 <img> 会变成裂图
        const first = run.outputs.find((o) => o.kind === 'image' || o.kind === 'animation')
          || run.outputs.find((o) => !o.kind)
        return first ? this.imageUrl(first) : null
      })(),
      error: run.error ? String(run.error.message || run.error).slice(0, 200) : null,
    }
  }

  imageUrl(o) {
    const q = new URLSearchParams({ filename: o.filename, subfolder: o.subfolder || '', type: o.type || 'output' })
    return `${PREFIX}/img?${q.toString()}`
  }

  // -- comfy events

  onEvent(msg) {
    const type = msg?.type
    const data = msg?.data || {}
    if (type === 'execution_start') {
      this.lastStartAt = Date.now()
      const run = this.createRun(data.prompt_id)
      run.status = 'running'
      this.broadcast({ t: 'run:summary', run: this.summary(run) })
      return
    }
    if (type === 'execution_cached') {
      const run = this.runs.get(data.prompt_id) || this.createRun(data.prompt_id)
      for (const id of data.nodes || []) run.nodeStates[String(id)] = 'cached'
      this.broadcast({ t: 'nodes', id: run.id, states: { ...run.nodeStates } })
      return
    }
    if (type === 'executing') {
      const id = data.prompt_id
      if (!id) return
      const run = this.runs.get(id) || this.createRun(id)
      if (data.node === null || data.node === undefined) {
        // ComfyUI 用「executing node=null」宣告这个 prompt 跑完
        if (run.status === 'running') {
          run.status = 'success'
          this.finish(run)
        }
        return
      }
      const nodeId = String(data.node)
      for (const [nid, st] of Object.entries(run.nodeStates)) {
        if (st === 'running' && nid !== nodeId) run.nodeStates[nid] = 'done'
      }
      run.nodeStates[nodeId] = 'running'
      run.currentNode = nodeId
      run.progress = { value: 0, max: 0, node: nodeId }
      this.broadcast({ t: 'nodes', id, states: { ...run.nodeStates }, current: nodeId })
      this.broadcast({ t: 'progress', id, progress: run.progress })
      return
    }
    if (type === 'progress') {
      const run = (data.prompt_id && this.runs.get(data.prompt_id)) || this.currentRun()
      if (!run) return
      run.progress = { value: data.value, max: data.max, node: String(data.node ?? run.currentNode ?? '') }
      this.broadcast({ t: 'progress', id: run.id, progress: run.progress })
      return
    }
    if (type === 'executed') {
      const run = this.runs.get(data.prompt_id)
      if (!run) return
      const nodeId = data.node !== undefined ? String(data.node) : ''
      if (nodeId) run.nodeStates[nodeId] = 'done'
      for (const item of collectOutputMedia(data.output)) {
        if (run.outputs.length >= MAX_OUTPUTS_PER_RUN) break
        const entry = { ...item, node: nodeId, at: Date.now() }
        run.outputs.push(entry)
        this.broadcast({ t: 'output', id: run.id, output: { ...entry, url: this.imageUrl(entry) } })
      }
      this.broadcast({ t: 'nodes', id: run.id, states: { ...run.nodeStates } })
      return
    }
    if (type === 'execution_error') {
      const run = this.runs.get(data.prompt_id) || this.createRun(data.prompt_id)
      run.status = 'error'
      run.error = {
        message: data.exception_message || '执行失败',
        node: data.node_id !== undefined ? String(data.node_id) : null,
        nodeType: data.node_type || '',
        traceback: String(data.traceback || '').slice(-4000),
      }
      this.finish(run)
      return
    }
    if (type === 'execution_interrupted') {
      const run = this.runs.get(data.prompt_id)
      if (run) { run.status = 'interrupted'; this.finish(run) }
      return
    }
    if (type === 'status') {
      const q = data.status?.exec_info?.queue_remaining
      this.broadcast({ t: 'queue', remaining: typeof q === 'number' ? q : null })
      if (q === 0) this.settleRunning()
    }
  }

  settleRunning() {
    for (const run of this.runs.values()) {
      if (run.status !== 'running') continue
      // 没有 executed 事件却已不在队列里：用 history 收尾
      this.reconcile(run)
    }
  }

  async reconcile(run) {
    try {
      const h = await this.json(`/history/${run.id}`)
      const entry = h?.[run.id]
      if (!entry) return
      if (!run.graph && entry.prompt?.[2]) {
        run.graph = entry.prompt[2]
        run.label = (pickPromptText(run.graph) || '执行').slice(0, 72)
        this.broadcast({ t: 'run:graph', id: run.id, graph: run.graph, label: run.label })
      }
      for (const [nodeId, out] of Object.entries(entry.outputs || {})) {
        for (const item of collectOutputMedia(out)) {
          if (run.outputs.some((o) => o.filename === item.filename && o.subfolder === item.subfolder)) continue
          const entryOut = { ...item, node: String(nodeId), at: Date.now() }
          run.outputs.push(entryOut)
          this.broadcast({ t: 'output', id: run.id, output: { ...entryOut, url: this.imageUrl(entryOut) } })
        }
        run.nodeStates[String(nodeId)] = 'done'
      }
      const st = entry.status?.status_str
      run.status = st === 'error' ? 'error' : 'success'
      if (st === 'error') run.error = { message: entry.status?.messages?.join?.('\n') || '执行失败', node: null }
      this.finish(run)
    } catch { /* ignore */ }
  }

  finish(run) {
    if (run.endedAt) return
    run.endedAt = Date.now()
    run.currentNode = null
    this.persist(run)
    this.broadcast({ t: 'run:end', id: run.id, run: this.summary(run), outputs: run.outputs.map((o) => ({ ...o, url: this.imageUrl(o) })) })
    // 成功但没有任何节点标完成（例如全 cached）：把图里其余节点标 done
    if (run.status === 'success') {
      for (const nid of Object.keys(run.graph || {})) {
        if (!run.nodeStates[nid]) run.nodeStates[nid] = 'done'
      }
      this.broadcast({ t: 'nodes', id: run.id, states: { ...run.nodeStates } })
    }
  }

  onPreview(buf) {
    if (buf.length < 9) return
    const eventType = buf.readUInt32BE(0)
    if (eventType !== 1) return
    const format = buf.readUInt32BE(4)
    const img = buf.subarray(8)
    if (img.length > 900000) return
    const run = this.currentRun()
    if (!run || run.status !== 'running') return
    const now = Date.now()
    if (run.previewAt && now - run.previewAt < 250) return
    run.previewAt = now
    const mime = format === 2 ? 'image/png' : 'image/jpeg'
    run.preview = `data:${mime};base64,${img.toString('base64')}`
    this.broadcast({ t: 'preview', id: run.id, data: run.preview })
  }

  currentRun() {
    let best = null
    for (const run of this.runs.values()) {
      if (run.status !== 'running') continue
      if (!best || run.startedAt > best.startedAt) best = run
    }
    return best
  }

  // -- past runs

  async seedHistory() {
    await this.ingestHistory(40)
  }

  async ingestHistory(maxItems) {
    let data
    try { data = await this.json(`/history?max_items=${maxItems}`, 20000) } catch { return }
    const entries = Object.entries(data || {}).filter(([, e]) => e?.prompt?.[2])
    entries.sort((a, b) => (b[1].prompt?.[3]?.create_time || 0) - (a[1].prompt?.[3]?.create_time || 0))
    let added = 0
    for (const [id, entry] of entries) {
      if (this.runs.has(id)) continue
      const graph = entry.prompt[2]
      const rawTime = entry.prompt?.[3]?.create_time || Date.now()
      const startedAt = rawTime > 1e12 ? Math.round(rawTime) : Math.round(rawTime * 1000)
      const fallbackLabel = Object.values(graph).map((n) => n.class_type).slice(0, 2).join(' → ')
      const run = {
        id,
        label: (pickPromptText(graph) || fallbackLabel || '历史执行').slice(0, 72),
        status: entry.status?.status_str === 'error' ? 'error' : 'success',
        source: 'history',
        startedAt,
        endedAt: null,
        graph,
        nodeIds: Object.keys(graph),
        nodeStates: Object.fromEntries(Object.keys(graph).map((nid) => [nid, 'done'])),
        currentNode: null,
        progress: null,
        preview: null,
        outputs: [],
        error: null,
      }
      for (const [nodeId, out] of Object.entries(entry.outputs || {})) {
        for (const item of collectOutputMedia(out)) {
          run.outputs.push({ ...item, node: String(nodeId), at: startedAt })
        }
      }
      this.runs.set(id, run)
      this.order.push(id)
      added++
      this.broadcast({ t: 'run:new', run: this.summary(run) })
    }
    if (added) {
      this.order.sort((a, b) => (this.runs.get(a)?.startedAt || 0) - (this.runs.get(b)?.startedAt || 0))
      this.trim()
    }
  }

  // -- http surface

  async handleState(res) {
    const runs = this.order
      .map((id) => this.runs.get(id))
      .filter(Boolean)
      .map((r) => this.summary(r))
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    const live = this.currentRun()
    this.send(res, 200, {
      ok: true,
      comfyUrl: this.comfy,
      connected: this.connected,
      live: live ? live.id : null,
      runs,
      saved: this.workflowDir || null,
    })
  }

  async handleRun(res, url) {
    const id = url.searchParams.get('id') || ''
    let run = this.runs.get(id)
    if (!run) return this.send(res, 404, { ok: false, error: '没有这次执行' })
    if (!run.graph) await this.attachGraph(run).catch(() => {})
    const detail = {
      ...this.summary(run),
      graph: run.graph,
      nodeStates: run.nodeStates,
      preview: run.preview,
      outputs: run.outputs.map((o) => ({ ...o, url: this.imageUrl(o) })),
      error: run.error,
      savedWorkflow: run.savedWorkflow || null,
    }
    this.send(res, 200, { ok: true, run: detail })
  }

  async handleEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    this.clients.add(res)
    const keep = setInterval(() => { try { res.write(': ping\n\n') } catch { /* ignore */ } }, 15000)
    if (keep.unref) keep.unref()
    const cleanup = () => { clearInterval(keep); this.clients.delete(res) }
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('close', cleanup)
  }

  async handleImage(res, url, req) {
    const filename = url.searchParams.get('filename') || ''
    const subfolder = url.searchParams.get('subfolder') || ''
    const type = extOfType(url.searchParams.get('type'))
    if (!filename) return this.send(res, 400, { ok: false, error: 'filename required' })

    // 快速路径：文件就在本机，直接读盘（省掉 ComfyUI 一次往返，产物库才不会一张张慢慢出）
    const local = join(this.outputDir || '', subfolder, filename)
    if (type === 'output' && this.outputDir && local.startsWith(this.outputDir) && existsSync(local)) {
      try {
        const st = statSync(local)
        const mime = mimeOf(filename)
        const range = req && req.headers && req.headers.range
        const m = range && /^bytes=(\d*)-(\d*)$/.exec(range)
        if (m) {
          const start = m[1] ? Number(m[1]) : 0
          const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1
          if (start >= st.size || end < start) {
            res.writeHead(416, { 'content-range': `bytes */${st.size}` })
            return res.end()
          }
          const buf = readFileSync(local)
          res.writeHead(206, {
            'content-type': mime,
            'content-length': end - start + 1,
            'content-range': `bytes ${start}-${end}/${st.size}`,
            'accept-ranges': 'bytes',
            'cache-control': 'max-age=300',
          })
          return res.end(buf.subarray(start, end + 1))
        }
        res.writeHead(200, {
          'content-type': mime,
          'content-length': st.size,
          'accept-ranges': 'bytes',
          'cache-control': 'max-age=300',
        })
        return createReadStream(local).pipe(res)
      } catch { /* 落到下面的代理路径 */ }
    }

    const q = new URLSearchParams({ filename, subfolder, type })
    try {
      const headers = {}
      const range = req && req.headers && req.headers.range
      if (range) headers.range = range
      const r = await fetch(`${this.comfy}/view?${q.toString()}`, { headers, signal: AbortSignal.timeout(60000) })
      if (!r.ok) return this.send(res, r.status, { ok: false, error: `view -> ${r.status}` })
      const ct = r.headers.get('content-type') || 'application/octet-stream'
      const body = Buffer.from(await r.arrayBuffer())
      const out = {
        'content-type': ct,
        'cache-control': 'max-age=120',
        'content-length': body.length,
        'accept-ranges': 'bytes',
      }
      const cr = r.headers.get('content-range')
      if (cr) out['content-range'] = cr
      res.writeHead(r.status === 206 ? 206 : 200, out)
      res.end(body)
    } catch (e) {
      this.send(res, 502, { ok: false, error: String(e.message || e) })
    }
  }

  async handleInterrupt(res) {
    try {
      await fetch(`${this.comfy}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(8000) })
      this.send(res, 200, { ok: true })
    } catch (e) {
      this.send(res, 502, { ok: false, error: String(e.message || e) })
    }
  }

  /** 产物库：直接扫 ComfyUI 的 output 目录，不管是谁出的图都能看见 */
  async handleLibrary(res, url) {
    const limit = Math.max(1, Math.min(800, Number(url.searchParams.get('limit') || 300)))
    if (!this.outputDir || !existsSync(this.outputDir)) {
      return this.send(res, 200, { ok: false, error: `找不到输出目录：${this.outputDir || '(未配置 comfyRoot)'}`, items: [], total: 0 })
    }
    const items = []
    const walk = (dir, depth) => {
      if (depth > 3) return
      let names = []
      try { names = readdirSync(dir) } catch { return }
      for (const name of names) {
        const p = join(dir, name)
        let st
        try { st = statSync(p) } catch { continue }
        if (st.isDirectory()) { walk(p, depth + 1); continue }
        const dot = name.lastIndexOf('.')
        if (dot < 0) continue
        const ext = name.slice(dot).toLowerCase()
        if (!/\.(png|jpe?g|webp|gif|mp4|webm|mov|wav|mp3)$/.test(ext)) continue
        const rel = p.slice(this.outputDir.length + 1).replace(/\\/g, '/')
        const sub = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
        const kind = /\.(mp4|webm|mov)$/.test(ext) ? 'video'
          : /\.(gif|webp)$/.test(ext) ? 'animation'
            : /\.(wav|mp3)$/.test(ext) ? 'audio' : 'image'
        const size = ext === '.png' ? pngSize(p) : null
        items.push({
          filename: name,
          subfolder: sub,
          kind,
          mtime: st.mtimeMs,
          bytes: st.size,
          w: size ? size.w : null,
          h: size ? size.h : null,
          url: `${PREFIX}/img?${new URLSearchParams({ filename: name, subfolder: sub, type: 'output' })}`,
        })
      }
    }
    walk(this.outputDir, 0)
    items.sort((a, b) => b.mtime - a.mtime)
    this.send(res, 200, { ok: true, total: items.length, items: items.slice(0, limit) })
  }

  /** 工作流库：读项目里的模板（workflows/*.json） */
  async handleWorkflows(res) {
    const dir = this.templateDir
    if (!existsSync(dir)) return this.send(res, 200, { ok: true, items: [] })
    const items = []
    let names = []
    try { names = readdirSync(dir) } catch { /* ignore */ }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.json')) continue
      const file = join(dir, name)
      try {
        const tpl = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
        const wf = tpl.workflow || {}
        items.push({
          name: name.replace(/\.json$/i, ''),
          title: tpl.title || '',
          nodes: Object.keys(wf).length,
          model: tpl.model || '',
          updated: statSync(file).mtimeMs,
        })
      } catch { /* 坏模板跳过 */ }
    }
    items.sort((a, b) => b.updated - a.updated)
    this.send(res, 200, { ok: true, items })
  }

  /** 单个模板的完整图（只读预览用） */
  async handleWorkflow(res, url) {
    const name = String(url.searchParams.get('name') || '').replace(/[^\w.-]/g, '')
    const file = join(this.templateDir, `${name}.json`)
    if (!name || !existsSync(file)) return this.send(res, 404, { ok: false, error: '没有这个模板' })
    try {
      const tpl = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      this.send(res, 200, {
        ok: true,
        name,
        title: tpl.title || '',
        graph: tpl.workflow || {},
        defaults: tpl.defaults || {},
        bindings: tpl.bindings || {},
      })
    } catch (e) {
      this.send(res, 500, { ok: false, error: String(e.message || e) })
    }
  }

  /**
   * 提交网关：ComfyUI 只把 execution_* 事件发给「提交的那个 client_id」，
   * 所以旁听是看不到节点级进度的。凡是想被实时看到的任务，都从这里提交——
   * 面板用自己的 client_id 代提交，于是每一条事件都会回到这里。
   */
  async handleSubmit(req, res) {
    let body
    try { body = await readBody(req, 32 * 1024 * 1024) } catch (e) {
      // 超限/连接中断：必须给出响应，否则调用方会一直挂着
      return this.send(res, 413, { error: { type: 'too_large', message: String(e.message || e) } })
    }
    let payload
    try { payload = JSON.parse(body || '{}') } catch { return this.send(res, 400, { error: { type: 'bad_json', message: '提交体不是合法 JSON' } }) }
    const { status, json, text } = await this.submit(payload.workflow || payload.prompt, payload.extra_data)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text ?? JSON.stringify(json))
  }

  /** 用面板自己的 client_id 提交；返回上游原样的状态与内容（含 node_errors） */
  async submit(workflow, extraData) {
    if (!workflow || typeof workflow !== 'object') {
      return { status: 400, json: { error: { type: 'no_prompt', message: '缺少 workflow' } } }
    }
    // 提交前确认这条 sid 在 ComfyUI 那边还登记着——否则任务会跑，事件全丢。
    if (this.socket) this.socket.ensure()
    const before = this.lastStartAt || 0
    const upstream = { prompt: workflow, client_id: this.clientId }
    if (extraData && typeof extraData === 'object') upstream.extra_data = extraData
    let r
    try {
      r = await fetch(`${this.comfy}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(upstream),
        signal: AbortSignal.timeout(60000),
      })
    } catch (e) {
      return { status: 502, json: { error: { type: 'connect', message: `连不上 ComfyUI：${String(e.message || e)}` } } }
    }
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 原样回传 */ }
    // 3 秒还没等到 execution_start：连接大概率又是半开的，重建一次。
    // ComfyUI 重连时会主动补一条「当前节点」的 executing，所以还能接上。
    if (json?.prompt_id) {
      const timer = setTimeout(() => {
        if ((this.lastStartAt || 0) <= before && this.socket) this.socket.connect()
      }, 3000)
      if (timer.unref) timer.unref()
    }
    return { status: r.status, json, text }
  }

  send(res, code, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  broadcast(event) {
    if (!this.clients.size) return
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const res of this.clients) {
      try { res.write(frame) } catch { this.clients.delete(res) }
    }
  }
}

// ---------------------------------------------------------------- templates

function loadTemplate(projectRoot, name) {
  const safe = String(name || '').replace(/[^\w.-]/g, '')
  if (!safe) return null
  const file = join(projectRoot, 'workflows', `${safe}.json`)
  if (!existsSync(file)) return null
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(raw)
}

/** 模板的 bindings/defaults 就是「参数 → 节点输入」的线，AI 只传参数就够了 */
function applyTemplate(tpl, params = {}) {
  const workflow = JSON.parse(JSON.stringify(tpl.workflow || {}))
  const given = { ...params }
  const bindings = tpl.bindings || {}
  const defaults = tpl.defaults || {}
  for (const key of Object.keys(bindings)) {
    if (given[key] === undefined && defaults[key] !== undefined) given[key] = defaults[key]
  }
  for (const key of (tpl.randomize || [])) {
    if (given[key] === undefined || given[key] === null) given[key] = Math.floor(Math.random() * 1e9)
  }
  for (const [key, target] of Object.entries(bindings)) {
    if (given[key] === undefined) continue
    const [nodeId, input] = target
    const node = workflow[nodeId]
    if (!node) continue
    node.inputs = node.inputs || {}
    node.inputs[input] = given[key]
  }
  return { workflow, params: given }
}

// ---------------------------------------------------------------- plugin

export function apply(ctx, config = {}) {
  const projectRoot = config.projectRoot || process.env.COMFYFORGE_ROOT || process.cwd()
  const comfyRoot = config.comfyRoot || process.env.COMFY_ROOT || ''
  const hub = new Hub({
    comfyUrl: config.comfyUrl || process.env.COMFY_URL || 'http://127.0.0.1:8188',
    comfyRoot,
    projectRoot,
    saveWorkflow: config.saveWorkflow !== false,
  })

  const originOf = (req) => {
    const host = req && req.headers && req.headers.host
    if (!host) return ''
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
    return `${proto}://${host}`
  }

  const routeDefs = [
    {
      kind: 'exact',
      path: `${PREFIX}/api/state`,
      handler: (req, res) => { hub.noteOrigin(originOf(req)); return hub.handleState(res) },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/api/run`,
      handler: (req, res) => hub.handleRun(res, new URL(req.url, 'http://127.0.0.1')),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/api/events`,
      handler: (req, res) => { hub.noteOrigin(originOf(req)); return hub.handleEvents(req, res) },
    },
    {
      kind: 'prefix',
      path: `${PREFIX}/img`,
      handler: (req, res) => hub.handleImage(res, new URL(req.url, 'http://127.0.0.1'), req),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/api/submit`,
      handler: (req, res) => {
        hub.noteOrigin(originOf(req))
        if (req.method !== 'POST') return hub.send(res, 405, { error: { type: 'method', message: '用 POST' } })
        return hub.handleSubmit(req, res)
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/api/interrupt`,
      handler: (req, res) => hub.handleInterrupt(res),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/api/library`,
      handler: (req, res) => hub.handleLibrary(res, new URL(req.url, 'http://127.0.0.1')),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/api/workflows`,
      handler: (req, res) => hub.handleWorkflows(res),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/api/workflow`,
      handler: (req, res) => hub.handleWorkflow(res, new URL(req.url, 'http://127.0.0.1')),
    },
  ]

  // 路由只能注册一次：插件热重载时旧实例可能没被回收（同一进程）。
  // 拿不到路由就是「搭车」模式——提交仍然打到现有那条管道上，事件还是同一个 client_id。
  const disposers = []
  let owner = true
  try {
    for (const def of routeDefs) disposers.push(ctx.webServer.register(def))
  } catch (e) {
    owner = false
    for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } }
    disposers.length = 0
  }

  if (owner) hub.start()

  const submitWorkflow = async (workflow) => {
    if (owner) return hub.submit(workflow, { comfy_usage_source: 'dsh-comfy-live' })
    let origin = ''
    try { origin = ctx.webServer.getOrigin() } catch { /* 还没 listen */ }
    if (!origin) return { status: 0, json: { error: { type: 'no_origin', message: '取不到 DSH 的 origin' } } }
    try {
      const r = await fetch(`${origin}${PREFIX}/api/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflow }),
        signal: AbortSignal.timeout(60000),
      })
      const text = await r.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* 原样 */ }
      return { status: r.status, json, text }
    } catch (e) {
      return { status: 0, json: { error: { type: 'connect', message: String(e.message || e) } } }
    }
  }

  // 给 AI 用的入口：提交即上墙。参数按模板 bindings 走，不必自己拼节点图。
  const runTool = {
    name: 'comfy_live_run',
    description:
      '通过 Comfy 实时台提交一次工作流并（可选）等它跑完。提交后 DSH 的「Comfy 实时台」面板会实时显示：' +
      '节点逐个点亮、当前步数、实时预览帧；跑完的图和这次执行的完整节点图都会留在面板里可回看。' +
      '参数按模板的 bindings 传（如 sd15_t2i 的 prompt/width/steps/seed），不用自己搭节点图。',
    parameters: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'workflows/<名>.json 的模板名，例：sd15_t2i、flux_t2i、flux_img2img' },
        params: { type: 'object', description: '模板参数对象（键名见模板 bindings），如 {prompt, width, height, steps, seed}', additionalProperties: true },
        wait_s: { type: 'integer', description: '最多等几秒看它跑完（0–50，默认 15）；没跑完就返回运行中，面板里继续直播' },
      },
      required: ['template'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    timeoutMs: 120000,
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      const tpl = loadTemplate(projectRoot, args.template)
      if (!tpl) return { text: `没有找到模板 workflows/${String(args.template || '').replace(/[^\w.-]/g, '')}.json` }
      const { workflow, params } = applyTemplate(tpl, args.params || {})
      const started = Date.now()
      const r = await submitWorkflow(workflow)
      if (r.status !== 200 || !r.json?.prompt_id) {
        const err = r.json?.error
        const lines = [`提交失败（HTTP ${r.status}）${err?.message ? '：' + err.message : ''}`]
        for (const [nid, ne] of Object.entries(r.json?.node_errors || {})) {
          for (const e of (ne.errors || [])) lines.push(`  节点 ${nid} (${ne.class_type}): ${e.message}`)
        }
        return { text: lines.join('\n') }
      }
      const id = r.json.prompt_id
      const waitS = Math.max(0, Math.min(50, Number(args.wait_s ?? 15)))
      let entry = null
      while (Date.now() - started < waitS * 1000) {
        const h = await hub.json(`/history/${id}`).catch(() => null)
        if (h?.[id]?.status?.status_str) { entry = h[id]; break }
        await new Promise((resolve) => setTimeout(resolve, 600))
      }
      const lines = [`prompt_id: ${id}`, `面板: Comfy 实时台（这次执行已在时间线里，节点跟着跑）`]
      if (!entry) {
        lines.push('状态: 运行中（面板里能看当前节点与进度；再调本工具或 comfy_wait 查结果）')
        return { text: lines.join('\n') }
      }
      const status = entry.status?.status_str || 'unknown'
      lines.push(`状态: ${status === 'success' ? '完成' : status === 'error' ? '失败' : status}`)
      lines.push(`耗时: ${((Date.now() - started) / 1000).toFixed(1)}s（含模型加载）`)
      const images = []
      for (const out of Object.values(entry.outputs || {})) {
        for (const item of collectOutputMedia(out)) images.push(item)
      }
      lines.push(`产物: ${images.length} 个`)
      for (const img of images) {
        const p = comfyRoot ? join(comfyRoot, 'output', img.subfolder || '', img.filename) : `${img.subfolder || ''}/${img.filename}`
        lines.push(`  ${p}`)
      }
      const keyParams = ['prompt', 'negative', 'width', 'height', 'steps', 'cfg', 'seed']
      const shown = keyParams.filter((k) => params[k] !== undefined).map((k) => `${k}=${String(params[k]).slice(0, 60)}`)
      if (shown.length) lines.push(`参数: ${shown.join(' · ')}`)
      return { text: lines.join('\n') }
    },
  }

  ctx.effect(() => ctx.tools.register(runTool), 'dsh-comfy-live: comfy_live_run')

  // 启动瞬间 webServer 可能还没 listen；事后补记一次，好让 MCP 找到这条通道
  let originTries = 0
  const originTimer = setInterval(() => {
    originTries++
    try { hub.noteOrigin(ctx.webServer.getOrigin()) } catch { /* 还没 listen */ }
    if (hub.origin || originTries > 20) clearInterval(originTimer)
  }, 500)
  if (originTimer.unref) originTimer.unref()

  ctx.effect(() => {
    return () => {
      clearInterval(originTimer)
      if (owner) {
        for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } }
        hub.dispose()
      }
    }
  }, 'dsh-comfy-live: routes + socket')

  return { hub, owner }
}
