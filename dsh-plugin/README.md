# Comfy 工作台（DSH 客户端插件）

这是 **DeepSeek Harness 的界面插件**，提供「Comfy 工作台」面板：
执行实时进度、节点图逐个点亮、实时预览、产物/工作流浏览。

> ⚠️ 它和仓库根目录的 **MCP 工具**（`mcp/server.mjs`，给 AI 调用的 33 个工具）是**两个东西**。
> 只装 MCP，界面上**什么都不会出现**。面板必须按下面这一份装。

---

## 三个必要条件（缺一条就是"装好了但看不到面板"）

1. 装进**你实际启动的那个 DSH profile**（桌面版通常 `desktop`，网页版通常 `web`）；
2. `package.json` 里有 `dsh.bundle.patch`（本包已带，勿删）；
3. **重启那个 profile** —— bundle 成员是**启动边界**，刷新浏览器不算。

另外一个隐性条件：`client.js` 是**构建产物**（`node build-client.mjs` 生成）。
它缺失时 DSH 不会报"面板缺失"，界面就是干净的空白，连右下角按钮都没有。

---

## 安装

以桌面版、profile 名为 `desktop`、插件目录为 `D:\DSH-ComfyForge\dsh-plugin` 为例：

```powershell
# 1) 确认构建产物在
dir D:\DSH-ComfyForge\dsh-plugin\client.js
#    不在就先构建（需要 Node）：
#    cd D:\DSH-ComfyForge\dsh-plugin ; node build-client.mjs

# 2) 确认 profile 名
dsh plugin --profile desktop list --depth 0

# 3) 安装（用目录路径，本包是 private + @local，不能从 npm 装）
dsh plugin --profile desktop add D:\DSH-ComfyForge\dsh-plugin

# 4) 确认 DSH 认到了这一层（必须有输出）
dsh --profile desktop --dump-config | Select-String -Pattern "comfy"

# 5) 重启 profile：完全退出 DSH 再打开（不是刷新页面）
```

### 如果第 3 步报 pnpm 错误

在该 profile 目录的 `package.json` 里加：

```json
"@local/dsh-comfy-live": "link:D:/DSH-ComfyForge/dsh-plugin"
```

然后在该 profile 目录执行 `pnpm install`。

---

## 验收（三条全过才算装好）

1. **Host 起来了**：`curl -s http://127.0.0.1:<port>/comfy-live/api/state` 返回 `{"ok":true,...}`
   （端口每次启动会变，用新进程打印的那个）
2. **界面上有入口**：左栏出现「Comfy 工作台」；右下角出现「Comfy 工作台」按钮
3. **点得开**：点左栏入口能进工作台页面，执行 / 产物 / 工作流 三个分区都在

---

## 装不上时的判定顺序（不要猜）

| 现象 | 说明 | 下一步 |
|---|---|---|
| `dsh plugin list` 里没有 | 没装进这个 profile | 用**实际启动**的 profile 名重装 |
| 有包、`--dump-config` 里没有 comfy 行 | DSH 没把它当 bundle | 查 `package.json` 的 `dsh.bundle.patch`；或包被装成了普通依赖 |
| 都正常、重启后仍无入口 | 客户端 bundle 没被加载 | 查安装目录里 `client.js` 在不在 |
| 想拿到运行时证据 | 客户端会把事实写回日志 | 看 `<项目目录>/.cache/client-diag.log` 有没有 `[apply]` 行 |

`[apply]` 有 → 客户端跑起来了，问题在入口注册；
`[apply]` 没有 → `client.js` 根本没被加载（构建产物缺失或 DSH 版本不兼容）。

---

## 配置

Host 半的配置在 `cordis.patch.yml`，默认**不写任何绝对路径**：

- `comfyUrl`：ComfyUI 地址，默认 `http://127.0.0.1:8188`
- `comfyRoot`：ComfyUI 目录（含 `main.py` 那层）；不填则问 `/system_stats` 自动推断
- `projectRoot`：项目目录；不填则取插件目录的上一级

也可以用环境变量：`COMFY_ROOT`、`COMFYFORGE_ROOT`、`COMFY_URL`。
