#!/usr/bin/env node
/**
 * verify-client.mjs — 自检「客户端这一半」是不是好的（不需要打开 DSH）。
 *
 * 为什么需要它：客户端 bundle 出问题时，DSH **不会报错**——
 * 界面就是干净的空白，面板没有、右下角按钮也没有。那时候唯一的办法是猜。
 * 这个脚本用假的 React / 假的 DSH 运行时把 client.js 真跑一遍，
 * 把"能不能加载、能不能注册进三个 slot、能不能渲染"逐条打出来。
 *
 * 用法：node dsh-plugin/verify-client.mjs
 * 退出码：0 = 全过；1 = 有失败项（会打印原因）
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientFile = join(here, 'client.js')
const pkgFile = join(here, 'package.json')

const checks = []
const ok = (name, extra) => checks.push({ name, pass: true, extra })
const bad = (name, why) => checks.push({ name, pass: false, extra: why })

// 1) 文件与清单
if (!existsSync(clientFile)) {
  bad('client.js 存在', '缺失 —— 先执行 node build-client.mjs（它是构建产物，不是手写文件）')
} else {
  ok('client.js 存在')
}

try {
  const pkg = JSON.parse(await import('node:fs').then((m) => m.readFileSync(pkgFile, 'utf8')))
  const exportOk = pkg.exports && pkg.exports['./client']
  const bundleOk = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  const clientOk = pkg.dsh && pkg.dsh.client
  exportOk ? ok('package.json exports["./client"]') : bad('package.json exports["./client"]', '缺这一项，DSH 找不到客户端入口')
  bundleOk ? ok('package.json dsh.bundle.patch') : bad('package.json dsh.bundle.patch', '缺这一项，DSH 不会把它当 bundle 层')
  clientOk ? ok('package.json dsh.client') : bad('package.json dsh.client', '缺这一项，客户端不会被扫描')
} catch (e) {
  bad('package.json 可解析', String(e && e.message))
}

// 2) 真跑一遍（假运行时）
const noop = () => {}
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop }
globalThis.location = { href: 'dsh-app://app/' }
globalThis.fetch = async () => ({ json: async () => ({ ok: true, runs: [] }) })
globalThis.EventSource = class { constructor() { this.onmessage = null } close() {} }
globalThis.window = {
  __ModuleLoader__: { load(mod) { globalThis.__mod = mod } },
  addEventListener: noop, localStorage: globalThis.localStorage, location: globalThis.location,
  fetch: globalThis.fetch, EventSource: globalThis.EventSource,
  setInterval: () => 0, setTimeout: () => 0, innerWidth: 1600, innerHeight: 900,
}
const React = {
  createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
  Component: class { constructor(p) { this.props = p || {} } },
  useState: (v) => [typeof v === 'function' ? v() : v, noop],
  useEffect: noop, useMemo: (fn) => fn(), useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn, useSyncExternalStore: (_s, get) => get(), useReducer: (r, i) => [i, noop],
}

try {
  await import(`file://${clientFile.replace(/\\/g, '/')}`)
  const mod = globalThis.__mod
  mod && mod.id ? ok('bundle 调用了 __ModuleLoader__.load', mod.id) : bad('__ModuleLoader__.load', '模块没有调用 load({id, factory})')
  if (!mod) throw new Error('module not registered')

  const exp = mod.factory((n) => { if (n === 'react') return React; throw new Error('unexpected require: ' + n) })
  typeof exp.apply === 'function' ? ok('factory 返回 apply()') : bad('factory 返回 apply()', '没有 apply，插件不会生效')

  const comps = []
  const ctx = {
    get: () => null,
    layout: { selectPanel: noop },
    slots: {
      inject(name, fn) { const c = fn(); if (typeof c === 'function') comps.push([name, c]) },
      register(_o, C) { return C },
    },
  }
  exp.apply(ctx)
  const want = ['sidebar.panellist', 'main', 'shell.overlay']
  const got = comps.map(([n]) => n)
  want.forEach((slot) => {
    got.includes(slot) ? ok(`注册进 ${slot}`) : bad(`注册进 ${slot}`, '没注册上 —— 这个 DSH 版本里可能没有该 slot')
  })
  for (const [name, C] of comps) {
    try { C({}); ok(`渲染 ${name}`) } catch (e) { bad(`渲染 ${name}`, String(e && e.message).slice(0, 120)) }
  }
} catch (e) {
  bad('加载 client.js', String((e && e.message) || e).slice(0, 200))
}

// 3) 结论
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.extra ? '  — ' + c.extra : ''}`)
console.log(`\n${failed.length ? 'FAILED' : 'OK'} · ${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) {
  console.log('\n客户端这一半是坏的：DSH 里表现为"界面没有任何面板、也没有右下角按钮"，且不报错。')
  process.exit(1)
}
// 正常退出：client.js 里有定时器，不显式退出的话 Node 会一直挂着
process.exit(0)
