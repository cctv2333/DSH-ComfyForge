// 37-float.js — 右侧浮窗：聊天区不动，任务进度挂在右边。
// 为什么不做成主面板：主面板会替换对话区（用户实测：点开就看不到聊天了）。

const FLOAT_KEY = 'cfl.float.v1'

function loadFloat() {
  try {
    const j = JSON.parse(localStorage.getItem(FLOAT_KEY) || '{}')
    return {
      open: !!j.open,
      w: Math.max(420, Math.min(900, Number(j.w) || 520)),
      dismissedAuto: !!j.dismissedAuto,
    }
  } catch { return { open: false, w: 520, dismissedAuto: false } }
}


let floatState = loadFloat()
const floatListeners = new Set()

function useFloat() {
  const [v, setV] = useState(floatState)
  useEffect(() => {
    const fn = () => setV(floatState)
    floatListeners.add(fn)
    return () => floatListeners.delete(fn)
  }, [])
  return v
}

function setFloat(patch) {
  floatState = { ...floatState, ...patch }
  try { localStorage.setItem(FLOAT_KEY, JSON.stringify(floatState)) } catch { /* ignore */ }
  for (const fn of floatListeners) { try { fn() } catch { /* ignore */ } }
}

/** 需要 ctx 才能"全屏打开"，所以由 apply 注入 */
function makeFloatPanel(ctx) {
  return function FloatPanel(props) {
    const s = useStore()
    const f = useFloat()
    const gripRef = useRef(null)
    // 主面板是否"真的在显示"：DSH 会把面板挂着但隐藏，
    // 所以必须看可见性（offsetParent），不能只看节点存不存在。
    const [mainOpen, setMainOpen] = useState(false)
    useEffect(() => {
      const check = () => {
        const el = document.querySelector('.cfl-main:not(.is-compact)')
        setMainOpen(!!el && el.offsetParent !== null)
      }
      check()
      const id = setInterval(check, 600)
      return () => clearInterval(id)
    }, [])
    const live = s.runs.find((r) => r.status === 'running') || null

    // 有新任务开始：自动把侧栏叫出来（除非用户手动收起过）
    useEffect(() => {
      if (live && !floatState.open && !floatState.dismissedAuto) setFloat({ open: true })
    }, [live ? live.id : null])

    // 拖左边缘改宽度
    const startResize = (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      const startX = e.clientX
      const startW = floatState.w
      const move = (ev) => setFloat({ w: Math.max(420, Math.min(900, startW + (startX - ev.clientX))) })
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    }

    if (!f.open || mainOpen) return null
    const step = live && live.progress && live.progress.max ? `${live.progress.value}/${live.progress.max} 步` : ''

    return h('div', { className: 'cfl-float', style: { width: f.w } },
      h('div', { className: 'cfl-float-bar' },
        h('span', { className: `cfl-conn${s.connected ? ' is-on' : ''}` }),
        h('b', { className: 'cfl-float-title' }, 'Comfy 工作台'),
        h('span', { className: 'cfl-float-meta' },
          live ? `正在跑${step ? ` · ${step}` : ''}` : (s.ready ? `${s.runs.length} 次执行` : '连接中…')),
        h('button', {
          type: 'button',
          className: 'cfl-icon-btn',
          title: '在主页打开',
          onClick: () => { try { ctx.layout.selectPanel(PANEL_ID) } catch { /* ignore */ } },
        }, '⤢'),
        h('button', {
          type: 'button',
          className: 'cfl-icon-btn',
          title: '收起（下次有任务时还会自动出现）',
          onClick: () => setFloat({ open: false }),
        }, '×')),
      h('div', { className: 'cfl-float-body' }, h(Panel, { compact: true })),
      h('div', { className: 'cfl-float-grip', ref: gripRef, onPointerDown: startResize, title: '拖动改宽度' }))
  }
}
