# Comfy 实时台：为什么以前是黑箱，现在怎么做到实时

- 日期：2026-11-05
- 代码：`dsh-plugin/`（`index.js` Host 半 + `client.js` Client 半）
- 形态：**DSH 插件**（不是另一个网页、不是另一个端口）

---

## 0. 一句话

以前你只能看"我做完的结果"，因为你看到的是 **事后从 `/history` 读出来的档**；
现在看的是 **ComfyUI 自己那条事件流**——节点开始/结束、第几步、每帧预览，都在跑的那一刻推到面板上。

---

## 1. 为什么以前必然看不到（根因，不是懒）

我读了本机 ComfyUI 0.44 的源码，三处硬事实：

| 事实 | 证据 |
|---|---|
| 事件只发给「提交时带的那个 client_id」的 socket | `execution.py:583` `send_sync("executed", …, server.client_id)`；`:742` `if "client_id" in extra_data: self.server.client_id = extra_data["client_id"]` |
| `execution_start` 同样只发提交者 | `execution.py:748` `add_message("execution_start", …, broadcast=False)` |
| 进度与预览帧（二进制）也走这个 sid | `server.py:1400` `send(event, data, sid=None)`；`sid` 传的就是 `server.client_id` |

**结论**：任何"旁听"的看板（包括仓库里原来的 `ui/server.mjs`）都不可能拿到节点级进度——
它连不上那条只为提交者开的事件通道。这就是为什么旧看板只能读 `/history`，也就是"事后再告诉你"。

旧看板另外三个毛病也一起修了：

- 要手动 `node ui/server.mjs`、自己找端口；
- 是**另一个网页**，不在 DSH 里，不会自动开；
- API 格式的工作流从不写进 ComfyUI，所以你在 ComfyUI 里根本找不到我跑过什么。

---

## 2. 现在的结构

```
                     ┌──────────────── DSH Host 进程 ────────────────┐
  AI 工具调用 ───────▶│ comfy_live_run（原生工具）                      │
  MCP comfy_run ─────▶│   └─ submit() ──▶ POST /comfy-live/api/submit │──┐
  脚本 h3.mjs …  ─────▶│                       （带面板自己的 client_id）│  │
                     │                                              │  │
                     │  Hub：连 ComfyUI /ws?clientId=…  ◀───────────┼──┘ POST /prompt
                     │   · execution_start / executing / progress    │     (client_id 一致)
                     │   · executed / execution_error / 预览帧        │
                     │   · 每次执行落 runs/live/<prompt_id>.json      │
                     │   · 转成 UI 格式写进 ComfyUI/user/…/workflows  │
                     │                                              │
                     │  webServer 同源路由：                          │
                     │   GET  /comfy-live/api/state                  │
                     │   GET  /comfy-live/api/run?id=                │
                     │   GET  /comfy-live/api/events   （SSE 推送）   │
                     │   GET  /comfy-live/img?…        （图代理）     │
                     │   POST /comfy-live/api/submit                 │
                     └──────────────────┬───────────────────────────┘
                                        │ 同一个 origin，无 CORS、无第二个端口
                     ┌──────────────────▼───────────────────────────┐
                     │ Client 半：sidebar.panellist + main 面板       │
                     │  时间线 │ 节点图（逐个点亮）│ 进度/预览/产物      │
                     └──────────────────────────────────────────────┘
```

关键点：**面板就是提交者**。ComfyUI 发给提交者的事件，正好落到面板自己手里。

---

## 3. 面板里有什么

- **侧栏图标**「Comfy 实时台」→ 主面板（`main` 槽，key `comfy-live`）。
- **自动打开**：只要有一次新的执行开始，且「跟随最新」是开的，自动切到面板（10 秒内不重复抢焦点）。
- **左：执行时间线**——正在跑的排最前，跑完的留档；点任意一条看它的节点图、参数、产物。
- **中：节点图**——这次执行的**真实 API 图**（不是示意图），节点状态：
  - 灰 = 还没跑；虚线 = 命中缓存；蓝 + 呼吸点 = 正在跑；绿 = 完成；红 = 失败节点。
- **右：这次执行**——状态/耗时/节点进度、进度条（第 N/M 步）、**实时预览帧**（ComfyUI 的 preview 流）、
  产物缩略图、关键参数（提示词/尺寸/步数/cfg/seed/模型）。
- **工作流落库**：每次执行开始就把图转成 UI 格式写进
  `ComfyUI/user/default/workflows/ComfyForge-<时间戳>-<id>.json`，
  你在 ComfyUI 里直接能打开、能改、能重跑。
- **落盘**：`runs/live/<prompt_id>.json`（图 + 产物 + 错误）。

---

## 4. 三个入口，一套管道

| 入口 | 是否实时 | 说明 |
|---|---|---|
| `comfy_live_run`（DSH 原生工具） | ✅ | 传模板名 + 参数即可；提交即上墙 |
| MCP `comfy_run` / `comfy_batch` / `comfy_sweep` / `comfy_edit` / `comfy_video` | ✅（重启 DSH 后） | `mcp/lib/comfy.mjs` 的 `submit()` 已改为优先走 `/comfy-live/api/submit`，失败才退回直连 |
| 你自己在 ComfyUI 界面里点 | ⚠️ 事后 | 8 秒内补进时间线（图 + 产物可看），但没有节点级直播——因为那条事件流只发给它自己的前端 |

`comfy_live_run` 的参数就是模板 `bindings` 里的键，例：

```json
{ "template": "sd15_t2i",
  "params": { "prompt": "1girl, solo, red scarf", "width": 512, "height": 768, "steps": 24, "seed": 7 },
  "wait_s": 20 }
```

---

## 5. 怎么确认它真的在跑（本次验证记录）

用 curl 挂着 SSE，然后经网关提交一次 8 节点的 SD1.5：

```
run:new      → 887f05e8…
nodes        → 1:cached 2:cached 5:running
progress     → 0/0 (节点 5)
run:graph    → 8 个节点、7 条连线（执行开始 1 秒内就拿到）
nodes        → 6:running
progress     → 1/10 … 10/10
preview      → data:image/jpeg;base64,…  （采样中途的实时帧）
executed     → output: comfyforge/live-gateway_00001_.png
run:end      → success
```

同时确认：
- `runs/live/887f05e8-….json` 落盘；
- `ComfyUI/user/default/workflows/ComfyForge-20261105-010647-887f05e8.json` 已生成（UI 格式，ComfyUI 可打开）。

---

## 6. 踩到的真 bug：半开连接把 sid 顶掉（2026-11-05 修）

现象：面板能开、能列历史，但新任务永远以 `source: history` 出现——**没有节点点亮、没有进度**。
`/comfy-live/api/state` 里 `connected: true`，ComfyUI 的 history 里也确实是我们的 `client_id`，就是收不到事件。

定位过程：

1. 写了一个独立探针（`.cache/ws-probe.mjs`），用新的 sid 连 WS、再用同一个 sid 提交——
   **事件全收到了**（`execution_start → progress → 二进制预览帧 → executed`）。
   说明协议、ComfyUI 投递、帧解析都没问题。
2. 于是问题只在「面板这条长连接」本身：ComfyUI 的 `sockets` 是以 `clientId` 为键的字典，
   连接时有 `self.sockets.pop(sid, None)`。**同一个 sid 出现两条连接**时，后一条顶掉前一条；
   任意一条断开又会把这个 sid 整个 pop 掉。
3. 我的重连逻辑有两个洞：`#drop()` 不判断连接代数、可并发 `connect()`；旧连接迟到的 `close/error`
   也会把新连接顶掉。结果就是「看起来连着，其实早就不在表里」——事件静默丢弃，
   只剩 8 秒一次的历史轮询，于是永远"事后"。

修复（`index.js` 的 `ComfySocket`）：

- 每次连接带 `gen` 代号，旧代的 `data/close/error` 一律忽略；`connect()` 先 teardown 再连；
- 重连定时器只留一个；
- 心跳判活：每 15s 发 ping，45s 没 pong 判定半开 → 重建；
- **提交前 `ensure()`**（保证 sid 在 ComfyUI 那边登记着）；
- **提交后 3s 没等到 `execution_start` → 主动重连一次**（ComfyUI 重连时会补一条当前节点的
  `executing`，还能接上）。

修完实测：一次 24 步任务收到 **56 条事件**，`progress 1/24 → 24/24`、8 帧预览、`run:end`，
落盘 `runs/live/2e763b57….json` + `ComfyForge-20261105-011832-2e763b57.json`。

---

## 7. 已知边界（说清楚，不糊）

1. **只有经网关提交的才有节点级直播**。原因见第 1 节，是 ComfyUI 的协议限制，不是我少写了一行。
   想让"任何来源"都直播，得改 ComfyUI 侧（自定义节点/补丁），那是另一个代价。
2. **历史补录是 8 秒轮询**：外部提交的任务会晚几秒出现在时间线，且没有逐节点过程。
3. **进程内路由只能注册一次**：插件热重载时若旧实例没被回收，新实例会进「搭车模式」
   （不重复注册路由，提交仍然打到现有管道上）。DSH 重启后自动回到正常模式。
4. 旧看板 `ui/server.mjs`（8790）仍可独立使用，但已被本面板取代，不再需要。

---

## 7. 下一步（可选，按价值排）

1. 面板里加「重跑这次」「改一个参数再跑」——不用再手搓命令。
2. 把 `h3.mjs` / `tools/*` 的提交也切到网关（现在只有 MCP 和原生工具切了）。
3. 时间线支持按模板/提示词筛选、按批次分组对比。
4. 失败时把 `traceback` 映射到具体节点（旧 bug #17），面板里直接标红那个节点。
