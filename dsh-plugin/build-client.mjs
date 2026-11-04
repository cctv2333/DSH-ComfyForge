// build-client.mjs — 把 client-src/ 的片段拼成 DSH 能加载的 client.js
//
// 为什么要这层：DSH 的客户端插件只接受一个 window.__ModuleLoader__.load 模块，
// 但我不想把 800 行 UI 全塞进一个文件（改一处要读全文）。所以源码按职责拆开，
// 这里只做"拼装"，不改写任何逻辑。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('./client-src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const files = readdirSync(SRC).filter((f) => f.endsWith('.js')).sort()

const parts = files.map((f) => `// ─── ${f} ${'─'.repeat(Math.max(0, 62 - f.length))}\n${readFileSync(join(SRC, f), 'utf8').trimEnd()}\n`)
const body = parts.join('\n')

const out = `/**
 * Comfy 实时台 — Client 半（由 client-src/*.js 拼装，勿直接编辑本文件）
 * 生成：node build-client.mjs
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-comfy-live',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

${body
  .split('\n')
  .map((line) => (line ? `    ${line}` : ''))
  .join('\n')}

    return { inject: ['slots', 'layout'], apply }
  },
})
`

writeFileSync(new URL('./client.js', import.meta.url), out, 'utf8')
console.log(`client.js ← ${files.length} 片段：${files.join(', ')}`)
