// 60-apply.js — 三个入口：左栏（主页大屏）、右侧整列停靠（主形态）、右下角卡片（入口）。
//
// 2026-11-05 定案（前后反复了三次，结论写死在这里）：
//  · 工作台是**跟左栏相对的一整列**，不是飘在对话上的卡片。
//    理由：它要长期开着、要能扫列表、要能看大图；浮窗会挡住对话，也不像个工具。
//  · 那一列用 DSH 自己的右侧栏（Ctrl+Alt+B）——它是唯一能让对话区让出位置、
//    而不是被盖住的地方。正文用 DockPanel（执行/产物库/工作流三档都在）。
//  · 右下角卡片只是**入口**：它去调 openTab；万一右侧栏调不动，才退化成抽屉。
//    入口的可见性永远不由"另一个还没验证成功的动作"决定（这条踩过坑）。
//
// 右侧栏注册的两个硬约束（都有代码依据，别再犯）：
//  1) id 全局唯一，重复注册会抛 "already registered"，而 DSH 热重载不重建注册表
//     → 注册失败不影响已有那个 tab，忽略即可。
//  2) guide 条目的 title / description 必须是**函数**（lib/client.js:624/618），
//     传字符串会让「开始」整页渲染失败 → 一片空白。这里干脆不注册 guide。

const TAB_ID = '@local/dsh-comfy-live/workbench'
const TAB_KIND = 'comfy'

let TAB_DBG = 'pending'

function registerTab(ctx, attempt) {
  const get = typeof ctx.get === 'function' ? ctx.get.bind(ctx) : null
  const tabs = get ? get('sidebarRightTabs') : null
  if (!tabs || typeof tabs.register !== 'function') {
    if (attempt < 10) {
      setTimeout(() => { try { registerTab(ctx, attempt + 1) } catch { /* ignore */ } }, 400)
      return
    }
    TAB_DBG = 'no-service'
    diag('tab.register', { ok: false, error: 'no-tabs-service' })
    return
  }
  try {
    tabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      priority: 'extension',
      title: () => 'Comfy 工作台',
      keepMounted: true,
    })
    TAB_DBG = 'ok'
    diag('tab.register', { ok: true, attempt })
  } catch (e) {
    // 已经注册过（热重载）＝ 上一份定义还在用，不算失败
    TAB_DBG = 'exists'
    diag('tab.register', { ok: false, error: String((e && e.message) || e).slice(0, 90) })
  }
  try {
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
    }, DockBoundary))
    diag('tab.body', { ok: true })
  } catch (e) {
    diag('tab.body', { ok: false, error: String((e && e.message) || e).slice(0, 90) })
  }
}

/** 打开右侧那一列；返回 true 表示交给了 DSH 的右侧栏 */
function openWorkbench(ctx) {
  try {
    const get = typeof ctx.get === 'function' ? ctx.get.bind(ctx) : null
    const right = get ? get('sidebarRight') : null
    if (right && typeof right.openTab === 'function') {
      // 栏是收着的就先把栏展开：用户点按钮就是要看见工作台，
      // 不能只弹一句"请按 Ctrl+Alt+B"再让他自己来（之前就是这个行为）。
      try {
        const expanded = typeof right.isExpanded === 'function' ? right.isExpanded() : true
        if (!expanded && typeof right.toggleExpanded === 'function') {
          right.toggleExpanded()
          diag('open.expand', { ok: true })
        }
      } catch { /* 展开失败也继续试 openTab */ }
      right.openTab(TAB_KIND)
      diag('open.tab', { ok: true })
      return true
    }
    diag('open.tab', { ok: false, error: 'no-openTab' })
  } catch (e) {
    diag('open.tab', { ok: false, error: String((e && e.message) || e).slice(0, 90) })
  }
  return false
}

/**
 * 安全注册：DSH 版本之间 slot 名字会变（新机器上 0.2.0 就是这种情况）。
 * 任何一处 inject/register 抛错，都只应该"少一个入口"，绝不能让整个 apply 失败——
 * apply 一失败，面板就完全不出现，而且界面上不会说为什么。所以逐个包起来，并记日志。
 */
function trySlot(ctx, slot, opts, Comp) {
  try {
    if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
      diag('slot.skip', { slot, why: 'no-slots' })
      return false
    }
    ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, ...opts }, Comp))
    diag('slot.ok', { slot })
    return true
  } catch (e) {
    diag('slot.fail', { slot, error: String((e && e.message) || e).slice(0, 120) })
    return false
  }
}

function apply(ctx) {
  UI_CTX = ctx
  try { diagInstall() } catch { /* ignore */ }
  let registered = 0
  try {
    const get = typeof ctx.get === 'function' ? ctx.get.bind(ctx) : null
    diag('apply', {
      slots: !!(ctx && ctx.slots),
      tabs: !!(get && get('sidebarRightTabs')),
      layout: !!(ctx && ctx.layout),
      href: String(location.href).replace(/[?].*/, ''),
    })
  } catch { /* ignore */ }

  // 左栏入口：主页面板（大屏看画布/大图时用）
  if (trySlot(ctx, 'sidebar.panellist', { id: PANEL_ID, order: 30, label: 'Comfy 工作台' }, PanelIcon)) registered++

  if (trySlot(ctx, 'main', { key: PANEL_ID }, ComfyPanelBoundary)) registered++

  // 右侧整列停靠（主形态）
  try { registerTab(ctx, 0) } catch { /* ignore */ }

  // 右下角卡片（入口 / 退路）
  try {
    const FloatPanel = makeFloatPanel(ctx, () => openWorkbench(ctx))
    if (trySlot(ctx, 'shell.overlay', { id: 'comfy-live-float', order: 55, label: 'Comfy 工作台入口' }, FloatPanel)) registered++
  } catch { /* 没有 shell.overlay 也还有左栏入口 */ }

  // 一个入口都没注册上，说明这台机器的 DSH 版本和插件对不上：
  // 至少把事实写进诊断日志，而不是"面板没出现、什么都没说"。
  try { diag('apply.done', { registered, slots: ['sidebar.panellist', 'main', 'shell.overlay'] }) } catch { /* ignore */ }

  try {
    boot()
  } catch { /* 数据流起不来也不影响手动点开 */ }
}
