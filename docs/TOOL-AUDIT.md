# ComfyForge 代码结构体检

- 时间：2026-11-04
- 范围：`mcp/`（MCP 服务）、`tools/`、`ui/`
- 结论：**不算臃肿，但有一处该拆、两处该下沉、三处该补。**

> 这是一份**真实的自我审计**，保留的是当时的判断（含已经过时的部分），因为"怎么发现问题的"比"结论"更有参考价值。
> 文中 `✅ 已完成` 标记的条目，是审计之后当轮就做掉的。

## 一、体量实测

| 区域 | 文件数 | 行数 | 说明 |
|---|---|---|---|
| `mcp/` | 22 | 5,194 | 含 `server.mjs` 1,903 + 16 个 lib |
| `tools/` | 12 | 994 | 独立脚本（出片、体检、修复） |
| `ui/` | 1 | 250 | 看板（读 runs/） |
| **合计** | **38** | **6,438** | 平均 **215 行/文件** |

工具数：**30 个 MCP 工具** → 平均每个工具约 170 行（含 lib 分摊）。

判断标准（我的口径）：

- < 200 行/文件：健康
- 单个文件 > 1,500 行：**需要拆分**（`server.mjs` 踩线）
- 一个工具族跨 3 个以上文件：碎片化（没有发生）

所以：**总量不臃肿**，问题集中在 `server.mjs` 这一个文件上。

## 二、真正的问题（按严重度）

### P0：`server.mjs` 单文件承载 30 个工具的注册 + 全部 payload 构造

现状：1,903 行，包含
- 30 个 `server.tool(...)` 注册
- 图片/蒙版/合成/替换的 workflow 组装
- 指标裁剪、路径处理、错误包装

后果：
- 改一个工具要在一个大文件里跳来跳去；
- 新增"视频"族时只能继续往里堆；
- 编译期没有任何类型约束，字段写错只能靠跑。

建议拆成（按域，不动 lib）：

```
mcp/
  server.mjs            # 只做 server 创建 + import 各工具族 + 启动（~120 行）
  tools/
    image.mjs           # run/sweep/batch/look/region/inspect/snapshot
    edit.mjs            # edit/replace/restructure/composite/place/upload
    workflow.mjs        # templates/runs/workflows/nodes/check
    system.mjs          # health/models/profile/queue/log/activity/doctor
    media.mjs           # video/sheet/frames（新增）
```

工作量：**半天**，全部是机械搬移 + 回归（selftest 75 项可兜底）。

### P1：`check-workflow` 逻辑在 `tools/`，MCP 和看板都用不上 —— ✅ 已完成（2026-11-04）

原问题：排查"缺节点"全靠 `tools/check-workflow.mjs`，但它是个独立脚本——
**每次都要起一个 shell 才能用**，看板也调不到。

已完成：
- 逻辑下沉到 `mcp/lib/workflowcheck.mjs`（纯函数：解析/比对/分档/渲染）
- 新增 MCP 工具 **`comfy_check_workflow`**（`path` 或直接给 `json` 文本，支持目录）
- `tools/check-workflow.mjs` 缩成 40 行 CLI 壳，和 MCP 共用同一份代码
- **顺手修掉一个真 bug**：rgthree 的 `Label / Fast Bypasser / Fast Groups Bypasser` 是**纯前端节点**
  （只有 JS 注册、没有 Python 类，永远不在 `/object_info` 里），原来会被误报成"缺件"。
  新增 **D 档「前端节点」**：扫 `.js` 源码确认后归入 D，不计入缺件数。
  修完后同一张工作流从"缺 3 个"变成"缺 0 个，另有 3 个前端节点"。

### P1：视频能力完全不在 MCP 里 —— ✅ 已完成（2026-11-04）

现状：出片靠一个独立的 Python 脚本 + 手写配置 JSON，MCP 里没有视频工具。
这与"工具链要能被 agent 直接调用"的定位是脱节的。

已完成：
- 新增 `mcp/lib/video.mjs`：帧数换算（5+17k）、工作流组装、提交、续等、抽帧、时长探测、时间码拼图
- 新增 MCP 工具 **`comfy_video`**（`start` / `status` / `frames` / `sheet`）
- 端到端自测通过：5 帧 320×192、2 步 → 28.6 秒出片，`localPath` 正确回传
- 拼图函数会先用 `ffmpeg -i` 读时长，再按时长算采样率，短到 0.2 秒的片子也能拼满格

工作量：实际约 **2 小时**（原估 1 天，因为复用了 `comfy.mjs` 的 submit/waitFor）。

### P2：测试只在入口层

`selftest.mjs` 75 项全过，但覆盖的是"工具能不能调通"，
没有覆盖"lib 的纯函数"（比如 `classifyModelFile`、`check-workflow` 的分档逻辑）。
一旦重构，纯函数层没有回归网。

建议：给 `lib/*.mjs` 的关键纯函数加 15-20 个单测，和 selftest 分开跑。

工作量：**半天**。

### P2：散落的硬编码路径

`<COMFY_ROOT>` 在若干 `tools/*.mjs`、`tools/*.py`、`ui/server.mjs` 里各写了一遍。
MCP 侧有 `config.mjs` 统一管理，脚本侧没有。

建议：脚本统一从 `mcp/lib/config.mjs` 读，或读环境变量 `COMFY_ROOT`。

工作量：**1 小时**。

> 后续：`tools/pre-upgrade-snapshot.mjs`、`tools/sheet-batch.mjs`、`mcp/test/control-inpaint.mjs`
> 已改成 `--root` / `COMFY_ROOT` / `COMFYFORGE_PY` / `COMFY_INPUT`，不再写死本机路径。

### P3：部分第三方包没有 git

有些自定义节点包是解压/拷贝进去的，**没有 `.git`、没有版本号、无法 `git pull`**。

后果：升级 ComfyUI 后若某个包不兼容，只能"重新下最新版覆盖"，无法精确回退到旧版本。

建议：公开仓库的包**删掉重装成 git clone**（确认无本地改动后再做）；
其余保留现状，但在 `docs/` 里登记来源 URL 和安装日期（`tools/pre-upgrade-snapshot.mjs` 会自动记录）。

工作量：**20 分钟**（两个包）。

## 三、不是问题的地方（避免过度重构）

- `lib/` 的 16 个模块职责清楚（config/comfy/img/templates/models/…），最大 258 行，**不需要拆**；
- 没有循环依赖；
- 没有重复造轮子（HTTP、轮询、指标都只有一份实现）；
- `ui/server.mjs` 只有 250 行，独立进程，不参与 MCP，**不急着动**。

## 四、本次已经做的改进

| 改进 | 文件 | 状态 |
|---|---|---|
| 升级前快照脚本（版本/git/pip/包清单/工作流） | `tools/pre-upgrade-snapshot.mjs` | ✅ 已跑通 |
| 升级预案（风险、步骤、回退） | `docs/UPGRADE-PLAN.md` | ✅ |
| **工作流体检下沉 + 新增 MCP 工具** | `mcp/lib/workflowcheck.mjs`、`comfy_check_workflow` | ✅ 探针确认已注册 |
| **新增视频工具** | `mcp/lib/video.mjs`、`comfy_video` | ✅ 端到端自测通过（28.6s 出片） |
| 前端节点误报修复（新增 D 档） | `mcp/lib/workflowcheck.mjs` | ✅ 同一工作流从"缺 3"变"缺 0" |
| 回归确认 | `mcp/test/selftest.mjs` | ✅ 75/75 通过 |

## 五、建议的动手顺序（2026-11-04 更新）

1. ~~先做 P1 的两件~~ ✅ 已完成：`comfy_check_workflow` + `comfy_video`
2. **升级 ComfyUI**（预案见 `docs/UPGRADE-PLAN.md`）——工具链能自检之后，升级验证会快很多
3. 升级后：用 `comfy_video` 重跑一次 H3，确认新节点/新签名
4. 再做 P0：把 `server.mjs` 按域拆开（此时视频族已定型，不会拆两次）
5. P2：给 lib 纯函数补单测；脚本改读 `COMFY_ROOT`
6. P3：公开仓库的包重装成 git clone

---

*数据来源：`Measure-Object -Line` 统计、`Select-String server.tool(` 计数、`node mcp/test/selftest.mjs` 实跑*
