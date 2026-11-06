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
