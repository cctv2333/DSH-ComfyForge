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
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { cpus, freemem, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

export const name = 'dsh-comfy-live'
export const inject = ['webServer', 'tools']
export { ComfySocket, Hub }

const PREFIX = '/comfy-live'
const MAX_RUNS = 60
const MAX_OUTPUTS_PER_RUN = 48

/**
 * 模板里的占位符（`<改成你的 ComfyUI 目录>`）不能当路径用。
 * 之前它会被原样当成合法字符串，结果 runs/live 和 output 全指向不存在的目录：
 * 重启后时间线空、产物库空，而日志里一句错都不报。所以凡是用路径的地方先过这一层。
 */
function usablePath(v) {
  const s = String(v || '').trim()
  if (!s || s.includes('<') || s.includes('>') || s.includes('改成你的')) return ''
  return s
}

/**
 * 这个目录**是不是本仓库**。
 *
 * 为什么光靠 `usablePath` 不够：`cordis.patch.yml` 里曾经写死过
 * `projectRoot: D:/dev/ComfyForge`。换一台机器，这个路径照样"格式合法"，
 * 于是通过检查，然后 `runs/live`、`workflows/`、`.cache/client-diag.log`
 * 全都指向不存在的目录 —— 面板起来是空的，诊断日志也一起丢掉，
 * 界面上还一句错都不报。用户看到的只有"面板出不来"。
 *
 * 判据用两个特征文件，随便一个在就认：`workflows/` 或 `mcp/server.mjs`。
 */
function looksLikeProjectRoot(p) {
  if (!p) return false
  try {
    return existsSync(join(p, 'mcp', 'server.mjs')) || existsSync(join(p, 'workflows'))
  } catch {
    return false
  }
}



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

/** 按次自动落盘的工作流最多留几份。再多就是把用户的工作流列表当日志文件用。 */
const MAX_RUN_DUMPS = 24

/** 只保留最近 N 份按次落盘的 UI 图（文件名里带 ISO 时间戳，按名字排序即按时间排序） */
function pruneRunDumps(dir, keep) {
  try {
    const files = readdirSync(dir).filter((f) => /^ComfyForge-\d{8}-\d{6}-[0-9a-f]{8}\.json$/.test(f)).sort()
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      try { rmSync(join(dir, f)) } catch { /* 删不掉就算了，不影响出图 */ }
    }
  } catch { /* 目录还不存在 */ }
}

/**
 * 从 API 图里猜"这次在做什么"。
 * 不能只看 inputs.text：Flux / MiniMax-H3 这类图的提示词在 prompt / positive / string 里，
 * 只看 text 会给视频任务安上 "UNETLoader → ModelAttentionBackend" 这种没意义的标题。
 */
function pickPromptText(api) {
  // 顺序有意义：靠前的键更像"正向提示词"。同一档里取最长的那条。
  const keys = ['text', 'prompt', 'positive', 'caption', 'string', 'value']
  // 反向提示词往往更长，先排除——否则标题会变成 "lowres, bad anatomy, worst quality"
  const NEG = /(lowres|worst quality|low quality|bad anatomy|bad hands|extra fingers|jpeg artifacts|watermark|signature|blurry|nsfw)/i
  const cands = []
  for (const n of Object.values(api || {})) {
    const inputs = n?.inputs || {}
    for (const k of keys) {
      const v = inputs[k]
      if (typeof v !== 'string') continue
      const s = v.trim()
      if (s.length < 12) continue
      if (/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i.test(s)) continue
      if (/^[\d.\s,%-]+$/.test(s)) continue
      cands.push({ s, rank: keys.indexOf(k), len: s.length, neg: NEG.test(s) })
    }
  }
  if (!cands.length) return ''
  const pos = cands.filter((c) => !c.neg)
  const pool = pos.length ? pos : cands
  pool.sort((a, b) => (a.rank - b.rank) || (b.len - a.len))
  return pool[0].s
}

/** 稳定的短哈希：同一段提示词永远得到同一个自动任务 */
function shortHash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
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
    // 仓库根：优先 config → 环境变量 → 本文件所在目录的上一级（插件就在 <仓库>/dsh-plugin）
    // 但 config 里可能是**别人机器**的绝对路径，格式合法却根本不存在，所以还要验它像不像本仓库；
    // 不像就丢掉并记下来（doctor 会显示），绝不能拿它去拼 runs/live 这种路径。
    const selfDir = dirname(dirname(fileURLToPath(import.meta.url)))
    const cfgRoot = usablePath(options.projectRoot)
    const envRoot = usablePath(process.env.COMFYFORGE_ROOT)
    this.projectRootIgnored = ''
    if (cfgRoot && looksLikeProjectRoot(cfgRoot)) this.projectRoot = cfgRoot
    else if (envRoot && looksLikeProjectRoot(envRoot)) this.projectRoot = envRoot
    else {
      this.projectRoot = selfDir
      // 只有"写了但不像本仓库"才算被忽略；留空是正常情况，不该报警
      this.projectRootIgnored = cfgRoot && !looksLikeProjectRoot(cfgRoot) ? cfgRoot : ''
    }
    this.saveDir = join(this.projectRoot, 'runs', 'live')
    this.templateDir = join(this.projectRoot, 'workflows')
    // 任务层（一次需求 → 多次执行 → 挑中的图），落在 runs/tasks/
    this.tasks = new Map()
    this.taskDir = join(this.projectRoot, 'runs', 'tasks')
    this.runTask = new Map()
    this._taskTimer = null
    // ComfyUI 根目录：配置里可能是模板占位符，也可能是空的；真值由 ensureComfyRoot() 兜底
    this.comfyRoot = usablePath(options.comfyRoot)
    this.workflowDir = ''
    this.outputDir = ''
    this.applyComfyRoot()
    // 系统监控：ComfyUI 的 /system_stats 每 2s 取一次，前端画折线、看显存会不会 OOM
    this.sys = null
    this.sysFails = 0
    this.sysSpark = []
    this.sysTimer = null
    this.cpuSnap = null
  }

  applyComfyRoot() {
    this.workflowDir = this.comfyRoot ? join(this.comfyRoot, 'user', 'default', 'workflows') : ''
    // 产物库要直接扫 ComfyUI 的 output 目录：很多图不是经这个面板出的，也得能看见
    this.outputDir = this.comfyRoot ? join(this.comfyRoot, 'output') : ''
  }

  /**
   * 不知道 ComfyUI 装在哪时，问它自己：/system_stats 的 system.argv[0] 就是 main.py 的绝对路径。
   * 比让用户改 yml 靠谱，也顺便修掉"配置里还是占位符"这类静默故障。
   */
  async ensureComfyRoot() {
    if (this.comfyRoot && existsSync(join(this.comfyRoot, 'output'))) return this.comfyRoot
    let stats = null
    try { stats = await this.json('/system_stats', 3000) } catch { return '' }
    const root = this.rootFromStats(stats)
    if (root) { this.comfyRoot = root; this.applyComfyRoot() }
    return root
  }

  rootFromStats(stats) {
    const argv = (stats && stats.system && stats.system.argv) || []
    for (const a of argv) {
      if (!/main\.py$/i.test(String(a))) continue
      const root = dirname(String(a))
      if (existsSync(join(root, 'output'))) return root
    }
    return ''
  }

  // -- lifecycle

  /** 启动时回读 runs/live/*.json（ComfyUI 的 history 重启即清空，磁盘这份才是长期记录） */
  loadPersisted() {
    if (!existsSync(this.saveDir)) return 0
    let names = []
    try { names = readdirSync(this.saveDir) } catch { return 0 }
    let added = 0
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.json')) continue
      try {
        const j = JSON.parse(readFileSync(join(this.saveDir, name), 'utf8'))
        if (!j || !j.id || this.runs.has(j.id)) continue
        const graph = j.graph || null
        // 老记录里的标题可能是「UNETLoader → ModelAttentionBackend」这种类名兜底
        // （那时只认 inputs.text，视频图的提示词在 prompt/positive 里）。回读时用新规则纠正。
        const derived = graph ? pickPromptText(graph) : ''
        const run = {
          id: j.id,
          label: (derived || j.label || '执行').slice(0, 72),
          status: j.status || 'success',
          source: 'disk',
          startedAt: Date.parse(j.startedAt) || Date.now(),
          endedAt: j.endedAt ? Date.parse(j.endedAt) : null,
          graph,
          nodeIds: graph ? Object.keys(graph) : [],
          nodeStates: graph ? Object.fromEntries(Object.keys(graph).map((nid) => [nid, 'done'])) : {},
          currentNode: null,
          progress: null,
          preview: null,
          outputs: Array.isArray(j.outputs) ? j.outputs : [],
          error: j.error || null,
          task: j.task || null,
        }
        // 没有产物也不是失败的记录没有回看价值：列表里就是一张空卡片。
        // （早期我自己跑的一批 selftest 就留下了十几条这种。）
        const outs = run.outputs.filter((o) => this.outputFileExists(o))
        if (!outs.length && run.status !== 'error') continue
        run.outputs = outs
        this.runs.set(run.id, run)
        this.order.push(run.id)
        added++
      } catch { /* 坏文件跳过 */ }
    }
    if (added) {
      this.order.sort((a, b) => (this.runs.get(a)?.startedAt || 0) - (this.runs.get(b)?.startedAt || 0))
      this.trim()
    }
    return added
  }

  // -- system monitor

  /** CPU 占用只能靠两次 cpus() 的时间差算，第一次采样返回 null */
  sampleCpu() {
    let idle = 0
    let total = 0
    for (const c of cpus()) {
      const t = c.times || {}
      idle += t.idle || 0
      total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0)
    }
    const prev = this.cpuSnap
    this.cpuSnap = { idle, total }
    if (!prev) return null
    const dt = total - prev.total
    if (dt <= 0) return null
    const used = 1 - (idle - prev.idle) / dt
    return Math.max(0, Math.min(100, Math.round(used * 100)))
  }

  /**
   * 取一次系统状态。ComfyUI 挂了也要给前端一个明确结论（连续 3 次失败 = down），
   * 不能静默——用户要的是「现在到底能不能跑」。
   */
  async pollSystem() {
    const now = Date.now()
    const cpu = this.sampleCpu()
    let stats = null
    try { stats = await this.json('/system_stats', 2500) } catch { stats = null }
    if (stats && !this.comfyRoot) {
      const root = this.rootFromStats(stats)
      if (root) { this.comfyRoot = root; this.applyComfyRoot() }
    }
    if (stats) this.sysFails = 0
    else this.sysFails += 1

    const prev = this.sys || {}
    const fallbackRamTotal = totalmem()
    const fallbackRamFree = freemem()
    const dev = stats && Array.isArray(stats.devices) && stats.devices.length ? stats.devices[0] : null
    const sys = {
      ok: !!stats,
      down: this.sysFails >= 3,
      fails: this.sysFails,
      at: now,
      cpu: cpu === null ? (prev.cpu ?? null) : cpu,
      gpu: dev ? String(dev.name || '').replace(/^(cuda|rocm|cpu):\d+\s*/i, '').split(' : ')[0] : (prev.gpu || ''),
      vramTotal: dev ? Number(dev.vram_total || 0) : (prev.vramTotal || 0),
      vramFree: dev ? Number(dev.vram_free || 0) : (prev.vramFree || 0),
      ramTotal: stats ? Number(stats.system?.ram_total || 0) : (prev.ramTotal || fallbackRamTotal),
      ramFree: stats ? Number(stats.system?.ram_free || 0) : (prev.ramFree || fallbackRamFree),
      version: stats ? String(stats.system?.comfyui_version || '') : (prev.version || ''),
      python: stats ? String(stats.system?.python_version || '').split(' ')[0] : (prev.python || ''),
    }

    const pct = (total, free) => (total > 0 ? Math.max(0, Math.min(100, Math.round((1 - free / total) * 100))) : null)
    const vramPct = pct(sys.vramTotal, sys.vramFree)
    const ramPct = pct(sys.ramTotal, sys.ramFree)
    sys.vramPct = vramPct
    sys.ramPct = ramPct
    // 低于 1GB 空闲显存就是下一次提交可能 OOM 的信号，先告诉用户
    sys.warn = stats && sys.vramTotal > 0 && sys.vramFree < 1024 ** 3 ? 'vram_low' : null

    if (stats) {
      this.sysSpark.push([now, sys.cpu ?? 0, vramPct ?? 0, ramPct ?? 0])
      while (this.sysSpark.length > 60) this.sysSpark.shift()
    }
    this.sys = sys
    this.broadcast({ t: 'sys', sys, spark: this.sysSpark, sparkLen: this.sysSpark.length })
  }

  startSystemMonitor() {
    if (this.sysTimer) return
    const tick = () => { this.pollSystem().catch(() => { /* 下一轮再说 */ }) }
    tick()
    this.sysTimer = setInterval(tick, 2000)
    if (this.sysTimer.unref) this.sysTimer.unref()
  }

  start() {
    try { mkdirSync(this.saveDir, { recursive: true }) } catch { /* 落盘失败不挡住实时 */ }
    // 先把磁盘上的执行记录读回来：ComfyUI 的 /history 在内存里，它一重启就空了，
    // 只从 /history 播种的话，重启后时间线会变成 0 条。
    this.loadPersisted()
    this.loadTasks()
    const clientId = `dsh-comfy-live-${randomBytes(4).toString('hex')}`
    this.clientId = clientId
    this.socket = new ComfySocket(`${this.comfy.replace(/^http/, 'ws')}/ws?clientId=${clientId}`, {
      open: () => { this.connected = true; this.broadcast({ t: 'conn', connected: true }) },
      close: () => { this.connected = false; this.broadcast({ t: 'conn', connected: false }) },
      message: (msg) => this.onEvent(msg),
      binary: (buf) => this.onPreview(buf),
    })
    this.socket.connect()
    this.startSystemMonitor()
    this.seedHistory().catch(() => { /* 历史拿不到不影响实时 */ })
    this.historyTimer = setInterval(() => {
      this.ingestHistory(10).catch(() => { /* 下一轮再说 */ })
    }, 8000)
    if (this.historyTimer.unref) this.historyTimer.unref()
    // 队列轮询：补上"没走面板提交"的任务，右栏才不会一直停在上一个任务上
    this.queueTimer = setInterval(() => {
      this.pollQueue().catch(() => { /* 下一轮再说 */ })
    }, 2000)
    if (this.queueTimer.unref) this.queueTimer.unref()
  }

  dispose() {
    if (this.socket) this.socket.dispose()
    if (this.historyTimer) clearInterval(this.historyTimer)
    if (this.queueTimer) clearInterval(this.queueTimer)
    if (this.sysTimer) clearInterval(this.sysTimer)
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
      // 必须用**解析后**的 this.projectRoot：this.opts.projectRoot 可能是别的机器的路径，
      // 往那儿写会静默失败，MCP 侧就永远拿不到 origin。
      const dir = join(this.projectRoot, '.cache')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'comfy-live-endpoint.json'),
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
      task: this.runTask.get(String(id)) || null,
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
    this.autoBindTask(run)
    this.broadcast({ t: 'run:graph', id: run.id, graph, label: run.label })
    this.persist(run)
    this.saveUiWorkflow(run).catch(() => { /* 写不进 ComfyUI 不影响实时 */ })
    this.broadcast({ t: 'run:summary', run: this.summary(run) })
  }

  saveUiWorkflow(run) {
    if (!this.opts.saveWorkflow || !run.graph) return Promise.resolve()
    const go = async () => {
      if (!this.workflowDir) await this.ensureComfyRoot()
      if (!this.workflowDir) return
      const info = await this.objectInfo()
      const ui = apiToUiGraph(run.graph, info, { name: `ComfyForge-${shortId(run.id)}`, title: run.label })
      if (!ui) return
      // 按次落盘的图放子目录：根目录只留给人工整理的模板。
      // 教训（2026-11-06）：以前直接写根目录，跑一次多一个文件，攒到 82 个
      // `ComfyForge-<时间戳>-<哈希>.json`，用户打开侧边栏一片乱码般的名字，
      // 而真正要用的模板一个都找不到 —— 「存好了」和「看得见」是两件事。
      const dir = join(this.workflowDir, '_运行记录')
      mkdirSync(dir, { recursive: true })
      const name = `ComfyForge-${stamp(new Date(run.startedAt))}-${shortId(run.id)}.json`
      writeFileSync(join(dir, name), JSON.stringify(ui, null, 2), 'utf8')
      pruneRunDumps(dir, MAX_RUN_DUMPS)
      run.savedWorkflow = `_运行记录/${name}`
    }
    return go()
  }

  persist(run) {
    if (!this.projectRoot) return
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
        task: run.task || null,
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

  // -- tasks：一次需求 = 一个任务（任务下挂着多次执行与「挑中的图」）
  //
  // 为什么要有这一层：右栏原来只能看「一次执行」，回答不了"我让它跑 100 张，
  // 现在到哪了、挑出几张"。任务 = 用户的一句需求，执行 = 其中一个 prompt。

  loadTasks() {
    if (!existsSync(this.taskDir)) return 0
    let names = []
    try { names = readdirSync(this.taskDir) } catch { return 0 }
    let n = 0
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.json')) continue
      try {
        const t = JSON.parse(readFileSync(join(this.taskDir, name), 'utf8'))
        if (!t || !t.id) continue
        const runIds = Array.isArray(t.runIds) ? t.runIds.map(String) : []
        // 一条执行都没有的任务是丢弃物（测试残留、或者被清掉记录的执行），别让它出现在界面上
        if (!runIds.length) { try { rmSync(join(this.taskDir, name), { force: true }) } catch { /* ignore */ } continue }
        this.tasks.set(String(t.id), {
          id: String(t.id),
          label: t.label || String(t.id),
          target: Number(t.target) || 0,
          note: t.note || '',
          createdAt: t.createdAt || Date.now(),
          runIds,
          picks: Array.isArray(t.picks) ? t.picks : [],
        })
        n++
      } catch { /* 坏文件跳过 */ }
    }
    return n
  }

  persistTask(t) {
    try {
      mkdirSync(this.taskDir, { recursive: true })
      // 文件名用 URL 编码：任务 id 常常是中文（"蓝发少女-30张"），直接当文件名会踩编码坑
      const name = `${encodeURIComponent(t.id).slice(0, 120)}.json`
      writeFileSync(join(this.taskDir, name), JSON.stringify(t, null, 2), 'utf8')
    } catch { /* 落盘失败不挡实时 */ }
  }

  ensureTask(id, meta = {}) {
    // id 保留原文（中文也算），只做长度与空白处理
    const tid = String(id || '').trim().slice(0, 64)
    if (!tid) return null
    let t = this.tasks.get(tid)
    if (!t) {
      t = {
        id: tid,
        label: String(meta.label || tid).slice(0, 80),
        target: Math.max(0, Number(meta.target) || 0),
        note: String(meta.note || '').slice(0, 300),
        createdAt: Date.now(),
        runIds: [],
        picks: [],
      }
      this.tasks.set(tid, t)
    } else {
      if (meta.label) t.label = String(meta.label).slice(0, 80)
      if (meta.target) t.target = Math.max(0, Number(meta.target) || t.target)
      if (meta.note) t.note = String(meta.note).slice(0, 300)
    }
    return t
  }

  /** 把一次执行挂到任务上（提交时就知道 prompt_id，不用等 execution_start） */
  bindRun(promptId, meta) {
    const t = this.ensureTask(meta.id, meta)
    if (!t) return null
    const id = String(promptId)
    if (!t.runIds.includes(id)) t.runIds.push(id)
    this.runTask.set(id, t.id)
    const run = this.runs.get(id)
    if (run) run.task = t.id
    this.persistTask(t)
    this.broadcastTask(t)
    return t
  }

  taskOf(run) {
    const tid = (run && run.task) || this.runTask.get(run && run.id)
    return tid ? this.tasks.get(tid) || null : null
  }

  taskSummary(t) {
    if (!t) return null
    const runs = t.runIds.map((id) => this.runs.get(id)).filter(Boolean)
    const done = runs.filter((r) => r.status === 'success').length
    const failed = runs.filter((r) => r.status === 'error' || r.status === 'interrupted').length
    const running = runs.filter((r) => r.status === 'running').length
    const outputs = runs.reduce((a, r) => a + r.outputs.length, 0)
    return {
      id: t.id,
      label: t.label,
      note: t.note,
      createdAt: t.createdAt,
      target: Math.max(t.target || 0, runs.length),
      total: runs.length,
      done,
      failed,
      running,
      outputs,
      picks: t.picks.length,
      pickItems: t.picks.map((p) => ({ ...p, url: this.imageUrl(p) })),
      runs: runs.map((r) => this.summary(r)),
    }
  }

  broadcastTask(t) {
    this.broadcast({ t: 'task', task: this.taskSummary(t) })
  }

  /** 执行状态变了就刷新一次任务进度（500ms 合并，避免每个 output 都算一遍） */
  touchTask(run) {
    const t = this.taskOf(run)
    if (!t) return
    if (this._taskTimer) return
    this._taskTimer = setTimeout(() => {
      this._taskTimer = null
      const tt = this.taskOf(run)
      if (!tt) return
      this.persistTask(tt)
      this.broadcastTask(tt)
    }, 500)
    if (this._taskTimer.unref) this._taskTimer.unref()
  }

  togglePick(taskId, pick) {
    const t = this.tasks.get(String(taskId || ''))
    if (!t || !pick || !pick.filename) return null
    const key = `${pick.type || 'output'}:${pick.subfolder || ''}/${pick.filename}`
    const i = t.picks.findIndex((p) => `${p.type || 'output'}:${p.subfolder || ''}/${p.filename}` === key)
    if (i >= 0) t.picks.splice(i, 1)
    else t.picks.push({
      filename: String(pick.filename),
      subfolder: String(pick.subfolder || ''),
      type: pick.type || 'output',
      kind: pick.kind || 'image',
      runId: pick.runId || null,
      at: Date.now(),
    })
    this.persistTask(t)
    this.broadcastTask(t)
    return this.taskSummary(t)
  }

  /**
   * 没人告诉我们"这是哪个任务"时，按提示词自动归堆。
   * 目的：右栏别再显示上一个任务——新的活一开跑，就该出现属于它的那一格。
   */
  autoBindTask(run) {
    if (!run || run.task) return
    const text = (run.graph && pickPromptText(run.graph)) || ''
    if (!text) return
    const head = text.replace(/\s+/g, ' ').trim()
    const t = this.ensureTask(`auto:${shortHash(head)}`, { label: head.slice(0, 24) })
    if (!t) return
    if (!t.runIds.includes(run.id)) t.runIds.push(run.id)
    run.task = t.id
    this.runTask.set(run.id, t.id)
    this.persistTask(t)
    this.broadcastTask(t)
  }

  /**
   * 每 2s 问一次 ComfyUI 的 /queue：哪些 prompt 正在跑/排队。
   *
   * 为什么需要它：面板只在"自己代提交"时才收得到 execution 系列事件与预览帧，
   * 直接打到 ComfyUI 的任务（别的窗口、旧的 MCP 进程）只有跑完才进 /history，
   * 于是右栏永远慢一拍、甚至一直停在上一个任务上。轮询 /queue 能把"现在在跑什么"补上：
   * 有 prompt_id、有完整 API 图，能标出正在跑；节点级进度和预览帧仍然需要走面板提交。
   */
  async pollQueue() {
    if (this._queueBusy) return
    this._queueBusy = true
    let q = null
    try { q = await this.json('/queue', 4000) } catch { q = null } finally { this._queueBusy = false }
    if (!q) return
    const inQueue = new Map()
    for (const item of [...(q.queue_running || []), ...(q.queue_pending || [])]) {
      if (!item || !item[1]) continue
      inQueue.set(String(item[1]), item[2] || null)
    }
    for (const [id, graph] of inQueue) {
      let run = this.runs.get(id)
      if (!run) {
        run = this.createRun(id, { source: 'queue' })
        run.source = 'queue'
      }
      let changed = false
      if (!run.graph && graph) {
        run.graph = graph
        run.label = (pickPromptText(graph) || Object.values(graph).map((n) => n.class_type).slice(0, 2).join(' → ') || '执行').slice(0, 72)
        run.nodeIds = Object.keys(graph)
        this.broadcast({ t: 'run:graph', id, graph, label: run.label })
        changed = true
        this.autoBindTask(run)
      }
      if (run.status !== 'running') {
        run.status = 'running'
        run.endedAt = null
        changed = true
      }
      if (changed) {
        this.broadcast({ t: 'run:summary', run: this.summary(run) })
        this.touchTask(run)
      }
    }
    // 从队列里消失还没收尾的（队列型任务收不到 executing=null）→ 用 /history 定状态
    for (const run of this.runs.values()) {
      if (run.status !== 'running' || inQueue.has(run.id)) continue
      this.reconcile(run).catch(() => { /* 下一轮 */ })
    }
  }

  async handleTasks(res) {
    const items = [...this.tasks.values()]
      .map((t) => this.taskSummary(t))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    this.send(res, 200, { ok: true, items, active: items.find((x) => x.running) || null })
  }

  async handlePick(req, res) {
    let body = ''
    try { body = await readBody(req, 1024 * 1024) } catch { /* 空体 */ }
    let j = {}
    try { j = JSON.parse(body || '{}') } catch { return this.send(res, 400, { ok: false, error: '不是合法 JSON' }) }
    const task = this.togglePick(j.task, j)
    if (!task) return this.send(res, 404, { ok: false, error: '没有这个任务或产物' })
    this.send(res, 200, { ok: true, task })
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
      task: run.task || null,
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
      this.touchTask(run)
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
        this.autoBindTask(run)
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
    this.touchTask(run)
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
      // 历史记录会指向已经被删掉的文件。这种执行点开就是破图 + 一片空白，
      // 留在列表里只会让人以为面板坏了。产物全没了就不进列表；报错的还留着（有信息量）。
      const alive = run.outputs.filter((o) => this.outputFileExists(o))
      if (run.outputs.length && !alive.length) continue
      if (!run.outputs.length && run.status !== 'error') continue
      run.outputs = alive
      // ComfyUI 的 history 自带各阶段时间戳，用它把「耗时」补上，别老是显示 —
      const msgs = entry.status && Array.isArray(entry.status.messages) ? entry.status.messages : []
      let startTs = 0
      let endTs = 0
      for (const m of msgs) {
        const name = Array.isArray(m) ? m[0] : ''
        const ts = Array.isArray(m) && m[1] ? m[1].timestamp : 0
        if (!ts) continue
        if (name === 'execution_start') startTs = ts
        if (name === 'execution_success' || name === 'execution_error' || name === 'execution_interrupted') endTs = ts
      }
      if (startTs) run.startedAt = Math.round(startTs)
      if (endTs && startTs && endTs >= startTs) {
        run.endedAt = Math.round(endTs)
        run.durationMs = Math.round(endTs - startTs)
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
      sys: this.sys,
      spark: this.sysSpark,
      tasks: [...this.tasks.values()].map((t) => this.taskSummary(t)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
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

  /**
   * 这条产物在磁盘上还在不在。
   * 历史记录（ComfyUI /history）会一直指向已经被删掉的文件，判一下才不会把
   * 破图和空白塞进列表里。temp 类型的产物归 ComfyUI 自己管，这里不判断。
   */
  outputFileExists(item) {
    if (!item || !item.filename) return false
    if (String(item.type || '') === 'temp') return true
    if (!this.outputDir) return true
    const sub = item.subfolder ? String(item.subfolder).replace(/\\/g, '/') : ''
    const full = join(this.outputDir, sub, String(item.filename))
    return full.startsWith(this.outputDir) && existsSync(full)
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
    if (!this.outputDir || !existsSync(this.outputDir)) await this.ensureComfyRoot()
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
    const { status, json, text } = await this.submit(payload.workflow || payload.prompt, payload.extra_data, payload.task)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text ?? JSON.stringify(json))
  }

  /** 用面板自己的 client_id 提交；返回上游原样的状态与内容（含 node_errors） */
  async submit(workflow, extraData, taskMeta) {
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
      // 任务归属在拿到 prompt_id 当场就记下来：等 execution_start 才挂会有空窗，
      // 而且 /history 播种出来的执行（source=history）永远等不到这个事件。
      if (taskMeta && (taskMeta.id || taskMeta.label)) {
        this.bindRun(json.prompt_id, { ...taskMeta, id: taskMeta.id || taskMeta.label })
      }
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
    {
      kind: 'exact',
      path: `${PREFIX}/api/tasks`,
      handler: (req, res) => hub.handleTasks(res),
    },
    {
      // 界面偏好落盘（入口按钮的位置等）。
      // 为什么不用 localStorage：DSH 每次启动端口都会变，浏览器按 origin 隔离存储，
      // 换端口等于换站点 → 存储是空的。位置必须存在磁盘上，跟端口无关。
      kind: 'exact',
      path: `${PREFIX}/api/ui`,
      handler: (req, res) => {
        const file = join(projectRoot, 'runs', 'ui-state.json')
        if (req.method === 'GET') {
          let data = {}
          try { data = JSON.parse(readFileSync(file, 'utf8')) } catch { /* 还没有 */ }
          return hub.send(res, 200, { ok: true, ...data })
        }
        if (req.method !== 'POST') return hub.send(res, 405, { ok: false, error: '用 GET 或 POST' })
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 20000) body = body.slice(0, 20000) })
        req.on('end', () => {
          let patch = {}
          try { patch = JSON.parse(body) || {} } catch { /* 忽略坏包 */ }
          let data = {}
          try { data = JSON.parse(readFileSync(file, 'utf8')) } catch { /* 还没有 */ }
          const next = { ...data, ...patch }
          try {
            mkdirSync(join(projectRoot, 'runs'), { recursive: true })
            writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
          } catch { /* 写不进去也不影响界面 */ }
          return hub.send(res, 200, { ok: true, ...next })
        })
      },
    },
    {
      // 给「面板渲染不出来」用的：DSH 自己的 HTTP 服务在跑，这个 URL 就能打开。
      // 用户不用找文件、不用开 DevTools，浏览器里看一段文本复制给我们就够。
      // 设计约束：**绝不能因为诊断而失败**——任何一步出错都只让对应字段变成错误文本。
      kind: 'exact',
      path: `${PREFIX}/health`,
      handler: async (req, res) => {
        const started = Date.now()
        const out = { ok: true, at: new Date().toISOString(), plugin: 'dsh-comfy-live' };
        const safe = async (key, fn) => { try { out[key] = await fn() } catch (e) { out[key] = `ERR: ${String(e?.message || e).slice(0, 200)}` } };

        await safe('paths', async () => ({
          projectRoot,
          comfyRoot: hub.comfyRoot || '(未解析)',
          projectRootIgnored: hub.projectRootIgnored || '',
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
        }));
        await safe('client', async () => {
          // 浏览器跑的是 client.js；它和 client-src 不同步时面板会表现成"旧代码"
          const dir = join(projectRoot, 'dsh-plugin')
          const disk = readFileSync(join(dir, 'client.js'), 'utf8')
          const files = readdirSync(join(dir, 'client-src')).filter((f) => f.endsWith('.js')).sort()
          const body = files.map((f) => `// ─── ${f} ${'─'.repeat(Math.max(0, 62 - f.length))}\n${readFileSync(join(dir, 'client-src', f), 'utf8').trimEnd()}\n`).join('\n')
          const expected = `/**\n * Comfy 实时台 — Client 半（由 client-src/*.js 拼装，勿直接编辑本文件）\n * 生成：node build-client.mjs\n */\nwindow.__ModuleLoader__.load({\n  id: '@local/dsh-comfy-live',\n  factory(require) {\n    const React = require('react')\n    const h = React.createElement\n    const { useCallback, useEffect, useMemo, useRef, useState } = React\n\n${body.split('\n').map((l) => (l ? `    ${l}` : '')).join('\n')}\n\n    return { inject: ['slots', 'layout'], apply }\n  },\n})\n`
          return {
            inSync: expected === disk,
            bytes: disk.length,
            parts: files.length,
            hint: expected === disk ? 'ok' : 'client.js 落后于 client-src：在 dsh-plugin/ 里跑 node build-client.mjs，然后刷新页面',
          }
        });
        await safe('comfy', async () => {
          const s = await (await fetch(`${hub.comfy}/system_stats`, { signal: AbortSignal.timeout(4000) })).json()
          return { ok: true, version: s?.system?.comfyui_version, vramFreeGB: +((s?.devices?.[0]?.vram_free || 0) / 1073741824).toFixed(2) }
        });
        await safe('host', async () => ({
          connected: hub.connected,
          runs: hub.runs?.size ?? null,
          clients: hub.clients?.size ?? null,
          origin: hub.origin || '',
        }));
        await safe('clientDiag', async () => {
          // 浏览器那半写回来的最后几行：里面会有 slot.ok / slot.fail / apply
          let text = ''
          try { text = readFileSync(join(projectRoot, '.cache', 'client-diag.log'), 'utf8') } catch { /* 没写过 */ }
          return text.split('\n').filter(Boolean).slice(-30)
        });

        out.elapsedMs = Date.now() - started
        out.howToReadIt = '把这一页全部复制给开发者即可；client.inSync 必须是 true，clientDiag 里要能看到 slot.ok';
        return hub.send(res, 200, out)
      },
    },
    {
      // 客户端没有 DevTools，界面出问题时只能靠它自己把事实写回来。
      // GET 读回日志；POST 追加一行。落盘在 <projectRoot>/.cache/client-diag.log。
      kind: 'exact',
      path: `${PREFIX}/api/diag`,
      handler: (req, res) => {
        const file = join(projectRoot, '.cache', 'client-diag.log')
        if (req.method === 'GET') {
          let text = ''
          try { text = readFileSync(file, 'utf8') } catch { /* 还没有日志 */ }
          return hub.send(res, 200, { ok: true, log: text.slice(-20000) })
        }
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 200000) body = body.slice(0, 200000) })
        req.on('end', () => {
          let line = body
          try {
            const j = JSON.parse(body)
            line = `${new Date().toISOString()} [${j.tag || '-'}] ${JSON.stringify(j.data === undefined ? null : j.data)}`
          } catch { /* 不是 JSON 就原样落盘 */ }
          try {
            mkdirSync(join(projectRoot, '.cache'), { recursive: true })
            writeFileSync(file, line + '\n', { flag: 'a' })
          } catch { /* 写不进去也不影响界面 */ }
          return hub.send(res, 200, { ok: true })
        })
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/api/pick`,
      handler: (req, res) => {
        if (req.method !== 'POST') return hub.send(res, 405, { ok: false, error: '用 POST' })
        return hub.handlePick(req, res)
      },
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

  const submitWorkflow = async (workflow, taskMeta) => {
    if (owner) return hub.submit(workflow, { comfy_usage_source: 'dsh-comfy-live' }, taskMeta)
    let origin = ''
    try { origin = ctx.webServer.getOrigin() } catch { /* 还没 listen */ }
    if (!origin) return { status: 0, json: { error: { type: 'no_origin', message: '取不到 DSH 的 origin' } } }
    try {
      const r = await fetch(`${origin}${PREFIX}/api/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflow, task: taskMeta }),
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
        task: { type: 'string', description: '任务标识（同一次需求的多次提交传同一个，例如 "蓝发少女-30张"）；右栏按任务显示进度与已选张数' },
        task_label: { type: 'string', description: '任务显示名（给人看的），省略时用 task' },
        task_target: { type: 'integer', description: '这次任务计划出几张（用于"7/30"这种进度），省略时按实际提交数算' },
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
      // 任务：同一句需求下的多次提交共用一个 task 标识，右栏按任务算进度与已选张数
      const taskMeta = args.task
        ? { id: String(args.task), label: args.task_label ? String(args.task_label) : String(args.task), target: Number(args.task_target) || 0 }
        : null
      const started = Date.now()
      const r = await submitWorkflow(workflow, taskMeta)
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
