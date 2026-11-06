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
