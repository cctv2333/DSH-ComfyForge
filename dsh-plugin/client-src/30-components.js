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
  return h('img', { className, src: item.url, alt: item.filename || '', loading: 'lazy' })
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
