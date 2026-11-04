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
