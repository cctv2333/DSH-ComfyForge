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
          ? h('div', { className: 'cfl-w-empty' }, '这个分类下还没有文件')
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
                : h('img', { className: 'cfl-tile-media', src: item.url, alt: '', loading: 'lazy', decoding: 'async' }),
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
