# 让 AI 装本插件的提示词（直接复制给对方）

> 用法：把下面整段（从「你是……」到结尾）复制给对方的 AI。
> 对方不需要懂 DSH，但 AI 需要能在这台机器上执行命令、读写文件。

---

你是这台机器上的执行者。任务：把 **DSH 的 Comfy 工作台插件**装进 **DeepSeek Harness（DSH）**，并验证它在界面里真的出现。请严格按顺序做，每步都要用命令的真实输出判断，不要凭印象说"应该可以了"。

## 背景（不要跳过，这决定你怎么装）

- 插件包名：`@local/dsh-comfy-live`
- 它是一个**本地插件**（`package.json` 里 `private: true`、scope 是 `@local/`），**不能从 npm 安装**，只能从目录或压缩包安装/链接。
- 它由两半组成：
  - `index.js`：Host 半（在 DSH 的 HTTP 上挂 `/comfy-live/*`）
  - `client.js`：Client 半（界面面板）。**注意：`client.js` 是构建产物**，由 `node build-client.mjs` 生成。如果它不存在，界面会**静默无面板、无任何错误提示**。
- 生效需要三件事同时成立（缺一个都看不到面板）：
  1. 装进**实际启动的那个 profile**；
  2. `package.json` 里有 `dsh.bundle.patch`（本包已有，不要删）；
  3. **重启那个 profile**（bundle 成员是启动边界，刷新浏览器不算）。

## 步骤

1. **确认插件目录里有这两个文件**
   - `dsh-plugin/index.js`
   - `dsh-plugin/client.js`
   如果 `client.js` 不存在：在 `dsh-plugin` 目录执行 `node build-client.mjs`，确认生成成功后再继续。若这台机器没有 Node，先装 Node 再继续。

2. **确认 DSH 实际用的 profile 名**
   桌面版通常是 `desktop`，网页版通常是 `web`。用下面命令确认（把 `<profile>` 替换成实际的）：

   ```bash
   dsh plugin --profile <profile> list --depth 0
   ```

3. **安装（用目录路径，不要用 npm registry）**

   ```bash
   dsh plugin --profile <profile> add <插件目录的绝对路径>
   ```

   如果这条命令报 `ERR_PNPM_ADDING_TO_ROOT` 或 pnpm 相关错误，改用：
   在该 profile 目录的 `package.json` 里加
   `"@local/dsh-comfy-live": "link:<插件目录绝对路径>"`
   然后在该 profile 目录执行 `pnpm install`。

4. **验证 DSH 认到了 bundle 层**

   ```bash
   dsh --profile <profile> --dump-config | grep -i comfy
   ```
   Windows：`... | Select-String -Pattern "comfy"`

   - **有输出** → 层加上了，继续第 5 步
   - **没有输出** → bundle 没被识别。停下来，把 `package.json` 的 `dsh` 字段贴出来（必须是 `{"bundle":{"patch":"./cordis.patch.yml"},"client":{...}}`），修好再重做第 3 步。

5. **重启那个 profile**（必须真的停掉旧进程）
   - 桌面版：完全退出应用，再打开
   - 网页版：停掉旧进程，`dsh web --no-open`，用新打印的 URL

6. **验收（三条全过才算装好）**

   a) Host 起来了（端口从新进程输出里取）：
   ```bash
   curl -s http://127.0.0.1:<port>/comfy-live/api/state
   ```
   期望：返回 JSON，含 `"ok":true`。

   b) 界面上左栏出现 **「Comfy 工作台」** 入口；右下角出现 **「Comfy 工作台」** 按钮。

   c) 点左栏入口能打开工作台页面（执行 / 产物 / 工作流 三个分区可见）。

7. **如果 6 条里有任何一条不成立**，按这个顺序取证据，不要猜：
   - **第一步永远先打开这个网址**（不需要浏览器那半渲染成功）：
     `http://127.0.0.1:<port>/comfy-live/health`
     把整页 JSON 原样贴回来。判定：
     · `clientDiag` 是空数组 → 客户端 bundle 一次都没加载（装/入口/版本问题）
     · 里面有 `slot.fail` → slot 名和这台机器的 DSH 版本对不上
     · `client.inSync` 是 false → 浏览器跑的是旧 bundle，`node build-client.mjs` 后刷新
   - 然后在插件目录跑一次无头自检，它用假的 React/DSH 运行时真跑 `client.js`：
     `node dsh-plugin/verify-client.mjs`（12 项，全 PASS 才说明 bundle 本身是好的）
   - `dsh plugin --profile <profile> list --depth 0` 的输出
   - `dsh --profile <profile> --dump-config` 里含 comfy 的行
   - DSH 启动输出里的**第一行错误**（patch 解析 / schema / 模块解析 / duplicate loader entry id）
   - `.cache/client-diag.log` 里有没有 `[apply]` 行（有 = 客户端跑起来了；没有 = `client.js` 没被加载）

   > 取证据的优先级：**health 页 > verify-client 输出 > 配置文件 > 日志文件**。
   > 前两个都是对方机器上一条命令/一个网址就能给出的，不需要找人要文件。

## 约束（重要）

- **不要修改** `dsh-plugin/` 里的源码或 `cordis.patch.yml` 的结构，除非我明确要求。
- **不要手工编辑** profile 的 `dsh.profile.bundles` 列表（会让后续升级更难查）。
- 不要用"另一个端口的 DSH"来假装验证成功；必须用你重启后打印的那个 URL。
- 每条结论都要贴命令输出，不要写"应该没问题"。
