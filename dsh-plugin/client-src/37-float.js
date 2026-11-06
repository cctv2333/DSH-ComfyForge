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
