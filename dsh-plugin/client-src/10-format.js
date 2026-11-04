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
