// 60-apply.js — 注册到 DSH：侧栏入口、主面板、右下角备用入口、自动切面板。

function apply(ctx) {
  // 侧栏入口（和主面板同一个 id，DSH 用 id 把两者连起来）
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: 'Comfy 工作台',
  }, PanelIcon))

  // 主面板
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, ComfyPanelBoundary))

  // 右侧浮窗：聊天区不动，进度挂在右边（这是主用法）
  try {
    const FloatPanel = makeFloatPanel(ctx)
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'comfy-live-float',
      order: 55,
      label: 'Comfy 工作台浮窗',
    }, FloatPanel))
  } catch { /* 没有 shell.overlay 也不影响主面板 */ }

  // 只启动数据流，不再自动切到主面板。
  // 主面板会替换对话区（用户明确不要）；新任务出现时由浮窗自己弹出来。
  try {
    boot()
  } catch { /* 数据流起不来也不影响手动点开 */ }
}
