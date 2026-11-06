# ComfyForge

**版本 `0.3.3`** · MIT · <https://github.com/cctv2333/DSH-ComfyForge>

把本机 ComfyUI 变成 **agent 能看见自己产出、能自检、能按证据改** 的工具链：
33 个 MCP 工具 + 一套客观质检 + 一个执行实时面板 + 一组零依赖的 CLI 工具。

它不是「一键出图」软件。核心是这条闭环：

```
生成 → 客观指标（分辨率/锐度/裁切/对比）→ 一次看多张（联络表）→ 按证据改参数 → 再跑
```

## 这个项目是写给 AI 用的，不是给人用的

这句话决定了它长什么样。

**人不用去管 ComfyUI 怎么装、节点怎么补、模型放哪个目录。** 人只做三件事：提需求、看结果、拍板。
剩下的——找 ComfyUI 在哪、判断是 local 还是 remote 模式、缺哪个节点包、模型文件名在别人机器上叫别的名字怎么办——
**都由 AI 现场查、现场判断、现场给出修法**。

所以这个仓库里最像"文档"的东西，其实是**给 AI 的判定链**：

- [`docs/AI-安装指南.md`](docs/AI-安装指南.md) —— **AI 照着这份就能把一套陌生环境装起来**：
  每一步怎么查、查到什么算过、不过怎么修、什么时候该停下来问人。
- `node tools/preflight.mjs` —— 能力三态：`ok` / `unknown` / `missing`。
  **连不上 ComfyUI 就说"不知道"，绝不假装通过。**
- `node mcp/doctor.mjs` —— 8 项环境自检，每项缺件都给「是什么、多大、放哪」。

三条不写死的原则（也是这个项目和"一键包"的区别）：

1. **不替人类下载任何东西。** 权重 6–50 GB，各有各的许可；工具只负责说清缺什么、多大、从哪拿。
2. **不静默降级。** 做不到就明说做不到，并给出下一步——最坏的是"看起来成功、其实功能缺失"。
3. **按角色匹配，不按文件名匹配。** 不同机器上同一个模型可能叫 `-fp16`、`-int8` 或别的名字；
   工具认的是"这是主模型 / 这是文本编码器"，不是"这个文件名"。

> 已有的例子：`comfy_check_workflow` 把缺件分成 A 已装未加载 / B 未安装 / C 来源未知 / **D 前端节点（正常，不用管）**四档。
> 少这一档，rgthree 那种纯前端节点会被一律误报成"缺 3 个"，然后 AI 会去装一堆本来不用装的东西。

---

## 做出来过什么（五个最有代表性的结果）

以下都是**本机实测**的数字，不是设计目标。出于素材版权与隐私，仓库内不放图；
每条都写清「做了什么 / 拿什么证明 / 硬约束在哪」。

### 1. 执行实时面板：把「跑完才知道」变成「跑的时候就能看见」

ComfyUI 只把 `execution_*` 事件发给**提交者的 client_id**，所以任何旁听式看板都拿不到节点级进度，
只能读 `/history`（事后）。这里的做法是**让面板自己成为提交者**：面板带自己的 client_id 提交，
ComfyUI 发给它的事件正好落到它手里。

- 效果：节点图按真实 API 图逐个点亮（灰=未跑、虚线=命中缓存、蓝=在跑、绿=完成、红=失败）、进度计数、**实时预览帧**、产物缩略图；
- 顺手解决两件长期痛点：每次执行自动把 API 图转成 UI 格式写进 `ComfyUI/user/default/workflows/_运行记录/`（在 ComfyUI 里可打开可重跑，只留最近 24 份），
  以及执行记录落盘 `runs/live/<prompt_id>.json`；
- 调试过的一个真 bug：同一 sid 出现两条连接时后一条会顶掉前一条，任意一条断开又会把 sid 整个 pop 掉 →
  表现为「面板开着但永远只有事后记录」。修法是连接带代数、提交前 `ensure()`、3 秒没等到 `execution_start` 主动重连。

![右侧栏工作台：执行 / 产物库 / 工作流三档](docs/img/rightbar-2026-11-05.png)

### 2. 视频二采配方：8GB 显存出 1216×704 带原生音轨

一采 608×352 打底 → 学习型 3D latent 放大 ×2 → 分块低噪声重采样（chunk 153 / overlap 17 / anchor 0.99）。

| 项 | 实测值 |
|---|---|
| 输出 | 1216×704 · 24fps · 带同步音轨 |
| 15.08 秒（362 帧 = `5+17×21`） | 二采全流程约 **812–830 秒** GPU |
| 5 秒 | 约 **285–325 秒** |
| 与「一采 lanczos 直接放大」比 | lap_var 51.5 → **234.6**（4.5×），hf_ratio 0.0086 → **0.0193** |

硬约束：`length` 必须是 `5+17k`；宽高必须是 32 的倍数；把 σ≈0.6 的半成品 latent 直接喂给放大网络会出彩色碎片。

### 3. 提示词结构的 A/B 实证：分镜是「写」出来的，不是「剪」出来的

同模型、同参考图、同 seed、全部采样参数不动，**只改提示词结构**：

| | A：六段式 + 6 个 `[Shot]` 时间码 | B：一段式短描述 |
|---|---|---|
| 提示词 | 5923 字符 | 783 字符 |
| 实际镜头数 | **6** | **1** |
| 强切点 | 6 个（3.67 / 5.25 / 6.58 / 9.04 / 13.58s） | **0** |
| 结果 | 有转场、有景别推进、动作有因果 | 退化成固定机位一件事，且跳过中间过程 |

结论：**镜头数、景别跨度、声音同步都写在提示词里**；后期切分只能复核，不能创造。

### 4. 自动分镜切分与复核（零依赖，只要 ffmpeg）

`node tools/shots.mjs <video> --out <dir>`：场景检测 → 合并密集切点（间隔 <`--min` 视为同一镜头内的高频变化）→ 切出每个镜头 + 首帧联络图 + `shots.json`。

实测 15.08 秒 / 6 镜的片子：原始切点 8 个 → 合并 5 个 → 切出 6 段；切点与提示词时间码偏差 **0.3–1.2 秒**。
这正是「提示词写的时间码」和「模型真正切的位置」之间的可核对关系。

### 5. 能力三态判定：缺什么就说缺什么，不说假话

`node tools/preflight.mjs` 把 8 项能力拆成三层依赖（零依赖 / ComfyUI 节点与节点包 / 模型权重），
每项只给三种状态：**ok / unknown / missing**。

- ComfyUI 没连上时，它说「不知道」，**不会假装通过**；
- 每项缺件都给出「是什么、多大、放哪个目录」；
- 每项都写了 `minimal`（最低门槛）与 `degrade`（缺了怎么降级）；
- **工具永不自动下载任何东西**——它只负责让你判断「补它值不值」。

---

## ⚠ 使用前必读（Critical Context）

**这不是开箱即用的发行包。** 仓库里只有 MCP 服务、工作流 JSON、脚本和文档，
**不含** ComfyUI、**不含**任何模型权重、**不含** Python。缺了下面任何一项，
工具能启动，但提交必然失败——这不是 bug，是缺依赖。

### 1. 外部依赖（缺了会怎样）

| 依赖 | 必需 | 体积（参考） | 缺了的表现 |
|---|---|---|---|
| ComfyUI（任意发行版） | 是 | ~1GB | `comfy_health` 报连不上；所有生成类工具失败 |
| 出图模型（见下「模板需要什么」） | 是 | 8–20GB | 提交时 `node_errors` 报模型文件不存在 |
| Python + Pillow + numpy | 是 | ~100MB | 图像指标/拼图/蒙版全废（`node mcp/doctor.mjs` 会标 fail） |
| Node.js ≥ 18 | 是 | — | 根本起不来（需要内置 `fetch` 与 `AbortSignal.timeout`） |
| ComfyUI-GGUF 自定义节点 | 模板需要 | 小 | 模板里的 `UnetLoaderGGUF` 节点不存在 → 提交被拒 |
| comfyui_controlnet_aux | 可选 | 小 | 只有全局重构/控制网相关工具不可用 |
| ControlNet Union Pro（FLUX） | 可选 | 4GB | `comfy_restructure` / 参考图控制不可用 |

### 2. 哪些东西是「机器相关」的（都可在配置里改，代码里没有硬编码）

MCP 服务启动时会按 **环境变量 → `comfyforge.config.json` → 自动探测** 的顺序解析这些值，
并把每个值的来源写进 `comfy_health` 的返回里，所以「它为什么在我这儿不对」有据可查。

- `comfyUrl`：ComfyUI 地址，默认 `http://127.0.0.1:8188`
- `comfyRoot`：ComfyUI 安装目录（含 `main.py` 的那层）。**可以不填**——不填就是 remote 模式：
  产物改走 HTTP `/view` 下载，代价是读不到 `comfyui.log`、也没有本地原图的捷径
- `outputDir` / `logPath`：默认由 `comfyRoot` 推出
- `python`：默认自动挑（优先 ComfyUI 便携包自带的 `python/python.exe`，它通常已装好 Pillow）

自动探测只在「名字里带 comfy」的目录上做**有界扫描**（深度 ≤3、目录数 ≤2500），
不会全盘递归；想关掉就写 `{"autoDetect": false}`。

### 3. 能力边界（我在这台机器上实测过的硬约束）

| 边界 | 事实 |
|---|---|
| 显存 | 8GB（RTX 5060 Ti）下 **一次只跑一张**；连发会显存碎片化卡死，需重启 ComfyUI |
| 分辨率 | FLUX.1-dev Q4 原生 ~1MP。1024×1024 正常，768 以下细节明显崩 |
| 文字 | **不会写字**。招牌/店招上的拉丁字母会变成 `GXIEE`、`7ATC` 这类乱码；汉字完全没有 |
| 具体机型 | C-130 这类「有明确轮廓的实物」靠提示词画不准，必须给参考图 + ControlNet |
| 局部编辑 | 能只改指定区域，但**新放进去的物体光照常与场景不匹配**（BUG-0010，open） |
| 长任务 | MCP 客户端单次调用约 60s 超时。所有等待工具都切成「等一小段 + `pending` 接力」，别把 `wait_s` 设 >55 |

### 4. 副作用与安全

- 会在仓库里写 `runs/`、`.cache/`、`picks.json`，在 ComfyUI 里写 `output/`、`input/`。
- `comfy_triage` 会**移动**文件到 `output/_trash/<时间戳>/` 并写 `manifest.json`，**不删除**，可 restore。
- 看板只监听 `127.0.0.1`，**没有鉴权**，不要挂到公网或 0.0.0.0。
- 部分工具会把图压成 JPEG 内联回传（控制上下文预算），原图始终在磁盘上。

---

## 60 秒接入

```powershell
# 1) 先确认环境（不连 MCP 也能跑，缺什么直接告诉你修法）
cd <仓库目录>
node mcp/doctor.mjs

# 2) 全 OK 后，挂到 MCP 客户端（以 DSH 为例，配置片段见下）
# 3) 让 agent 先调 comfy_health，它会把上面那份自检再报一遍
```

DSH 挂载（`～/.dsh/profiles/<profile>/cordis.patch.yml`，改完**重启 DSH** 才生效）：

```yaml
- insert:
    - id: mcp-comfyforge
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: comfy
        transport: stdio
        command: node            # 写成 node.exe 的绝对路径更稳
        args:
          - <仓库目录>/mcp/server.mjs
        env:
          COMFY_URL: http://127.0.0.1:8188
```

Claude Desktop / 其他 MCP 客户端同理：stdio，命令 `node`，参数 `mcp/server.mjs`。

> DSH 常驻 MCP 进程**不会热重载**：改 `mcp/` 下的代码后要重启 DSH；`workflows/*.json` 每次调用重读，改完即时生效。

## 配置

复制 `comfyforge.config.example.json` 为 `comfyforge.config.json` 再改（这个文件在 `.gitignore` 里）。

| 字段 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `comfyUrl` | `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `comfyRoot` | `COMFY_ROOT` | 自动探测 | 含 `main.py` 的目录；不填=remote 模式 |
| `outputDir` | `COMFY_OUTPUT_DIR` | `<comfyRoot>/output` | 产物目录 |
| `logPath` | `COMFY_LOG` | `<comfyRoot>/user/comfyui.log` | 日志（诊断用） |
| `python` | `COMFYFORGE_PY` | 自动挑选 | 需 Pillow+numpy |
| `pollMs` | `COMFYFORGE_POLL_MS` | `1200` | 轮询间隔 |
| `graceMs` | `COMFYFORGE_GRACE_MS` | `12000` | 「既不在队列也不在历史」的宽限 |
| `autoDetect` | — | `true` | `false` 关掉自动探测 |

## 模板需要什么

模板只是工作流 JSON，**不带权重**。`flux_t2i` / `flux_img2img` / `flux_inpaint` / `anime_scene` 共同需要：

| 文件 | 放到 | 备注 |
|---|---|---|
| `flux1-dev-Q4_K_S.gguf` | `models/unet/` | 需 [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) |
| `clip_l.safetensors` | `models/clip/` | |
| `t5xxl_fp16.safetensors` | `models/clip/` | 9.3GB；8GB 显存下走 CPU |
| `flux-ae.safetensors` | `models/vae/` | |

换成别的 FLUX / SD 系模型也行，但要自己改模板里的 `unet_name`/`clip_name`，
并接受「原生分辨率、推荐桶」随之变化（`models.json` 就是记这件事的）。

## 工具（33 个）

| 类别 | 工具 |
|---|---|
| 体检 / 环境 | `comfy_health` `comfy_models`（list/audit）`comfy_profile` `comfy_log` `comfy_nodes` |
| 生成 | `comfy_run` `comfy_batch` `comfy_wait` `comfy_wait_many` `comfy_queue` `comfy_sweep` |
| 视频 | `comfy_video`（start/status/frames/sheet/metrics） |
| 看图 / 质检 | `comfy_image` `comfy_snapshot` `comfy_inspect` `comfy_look` `comfy_region` |
| 改图 | `comfy_edit` `comfy_upload` `comfy_composite` `comfy_place` `comfy_replace` `comfy_restructure` |
| 归档 | `comfy_workflows` `comfy_check_workflow` `comfy_picks` `comfy_triage` `comfy_templates` `comfy_runs` |
| 记忆 / 校验 | `comfy_lessons` `comfy_journal` `comfy_activity` `comfy_lint_prompt` |

每个工具的详细语义、参数与「为什么这么设计」见 [`mcp/README.md`](mcp/README.md)。

## 看板

```powershell
node ui/server.mjs        # http://127.0.0.1:8790
```

把 `runs/`、输出图、精选清单变成网页：批次卡片、★ 精选、`/flow` 看真实执行图。
需要 `comfyRoot` 或 `COMFY_OUTPUT_DIR` 才能找到图。

## 故障排查

先跑 `node mcp/doctor.mjs`（`--offline` 跳过网络、`--json` 机器可读）。它检查：
配置文件、运行模式、ComfyUI 连通、产物目录、日志、Python（真跑一次 import）、缓存可写、
以及**每个模板引用的模型文件在本机是否存在**。

| 现象 | 先看 |
|---|---|
| 全部生成失败，提示 `node_errors` 缺文件 | `comfy_models`；模板需要的模型是否在 `models/` 对应子目录 |
| `连不上 ComfyUI` | ComfyUI 是否在跑；端口是否 8188；remote 的话 `COMFY_URL` 是否指向对 |
| 图像指标/拼图报 Python 错 | `node mcp/doctor.mjs`；`COMFYFORGE_PY` 指向一个有 Pillow+numpy 的 python |
| 跑到一半 OOM / 卡住无产出 | 显存碎片化：重启 ComfyUI，改单张串行 |
| 工具调用「超时」但队列还在跑 | 这是设计如此：用 `comfy_wait` 接力，别把 `wait_s` 调大 |

## 目录

```
mcp/          MCP 服务（server.mjs 只做装配；lib/ 各功能模块；tools/ 按域拆开的工具注册）
mcp/tools/    system / generate / view / edit / library / media + ctx.mjs（共享上下文）
workflows/    模板（纯 JSON，可手改，不含权重）
ui/           本地看板（旧版，已被实时面板取代，保留兼容）
dsh-plugin/   DSH 插件：Comfy 实时台（Host 半 + Client 半）
tools/        CLI 工具：preflight 体检 / shots 分镜切分 / storyboard 分镜与提示词 / prompt-lint 校验 / sweep 抽卡 /
              cleanup 清垃圾 / publish-workflows 把模板发布成 ComfyUI 侧边栏能点开的那几份 /
              workflow-diff 逐节点对比两份工作流 / plugin-doctor 面板出不来时的一键诊断 / fetch-hf-model 从镜像拉整套 HF 目录
docs/         设计文档、实测报告、已知问题
prompts/      提示词格式规范与范例
runs/         运行记录（生成产物，不入库）
.cache/       缩略图/拼图/下载缓存（不入库）
```

## 文档

| 文档 | 讲什么 |
|---|---|
| [`docs/AI-安装指南.md`](docs/AI-安装指南.md) | **给 AI 的**：陌生机器上怎么装、怎么判、缺什么怎么修、什么情况该停下来问人 |
| [`docs/已知问题.md`](docs/已知问题.md) | **先看这个**：硬约束、工具缺陷、踩过的坑，每条带「现象/原因/现状」 |
| [`docs/UPGRADE-PLAN.md`](docs/UPGRADE-PLAN.md) | ComfyUI 0.30 → 0.44 升级预案：收益证据、破坏面清单、10 分钟 checklist、回退方案 |
| [`docs/TOOL-AUDIT.md`](docs/TOOL-AUDIT.md) | 代码结构体检：哪一处该拆、哪两处该下沉、哪些「看起来乱其实没问题」 |
| [`docs/能力边界.md`](docs/能力边界.md) | 每项能力分三层依赖，缺一层会怎样、补它多大代价 |
| [`docs/H3-二采参考工作流解析.md`](docs/H3-二采参考工作流解析.md) | 逐节点拆解别人的高清二采工作流，以及哪几处不能照抄 |
| [`docs/视频生成流程.md`](docs/视频生成流程.md) | 从一张分镜参考图到一条带音轨成片的完整脉络与判断点 |
| [`docs/Comfy实时台-设计与实现.md`](docs/Comfy实时台-设计与实现.md) | 为什么旧看板必然只能「事后」，以及现在怎么拿到节点级直播 |
| [`docs/提示词校验与抽卡.md`](docs/提示词校验与抽卡.md) | 发出去之前怎么自查提示词，抽卡怎么排序 |
| [`docs/模型选型-2026-11-06.md`](docs/模型选型-2026-11-06.md) | 四种模型同提示词同种子实测对比，以及**用户审美判定**（MOSS > Krea-2 > FLUX.2 ≫ SDXL）与 SDXL 崩在哪 |
| [`docs/右侧栏接入-现状与下一步.md`](docs/右侧栏接入-现状与下一步.md) | 面板注册进 DSH 右侧栏踩到的两条硬约束（id 唯一、guide 的 title 必须是函数） |
| [`prompts/h3-r2v-提示词格式.md`](prompts/h3-r2v-提示词格式.md) | 六段式提示词规范（`subject_definitions` / `[Shot]` 时间码 / 声音同步） |

## 已知问题

完整清单见 [`docs/已知问题.md`](docs/已知问题.md)：硬约束、工具缺陷、踩过的坑，每条都写清「现象 / 原因 / 现状」。

几条最容易被踩到的：

- **日志只证明跑完了，不证明跑对了**：三次质量失败的出图，日志零错误零警告。
- **实时面板只直播「经网关提交」的任务**：你在 ComfyUI 界面里点的任务只有事后记录，这是 ComfyUI 协议限制。
- **没有进程级看门狗**：`tools/watchdog.mjs` 只观察、只记录、给下一步命令，**不杀也不拉起** ComfyUI（那样会打断别人的任务）。
- **模型槽只给候选，不自动替换**：`tools/model-slots.mjs` 会列出「本机没有这个文件，同目录里有这些候选」，换不换由人/AI 决定——换错模型比报错更糟。
- **BUG-0010（未彻底解决）**：局部编辑/放置物体后，新物体光照方向与场景不一致（贴纸感）。

### 0.3.2 已修

- `flicker` 切点污染 → 新增 `flickerNoCut`（剔除切点前后 2 帧），**排序分默认改用它**
- 产出分拣只有图片 → `comfy_triage` 现在认视频（大小/时长/读不出；坏文件仍可 restore）
- 权重只按文件名判断 → `preflight` 增加**体积校验**（±15%，0 字节与残文件会被判缺件），并给出**来源与许可**
- 模型文件名硬编码 → 新增 `tools/model-slots.mjs` 按角色给候选；H3 那条链的 5 个模型名支持环境变量覆盖
- `TOOL-AUDIT` 里一直缺的纯函数回归网 → 新增 `mcp/test/unit.mjs`（21 项）

## 能力清单

`node mcp/doctor.mjs` 最后会打印一张能力表：现在能做哪些事、缺哪一项、补它要多大代价。
判据只用三样可核实的东西——节点、`custom_nodes` 目录、`models` 目录里的文件；
**工具本身不下载、不安装任何东西**，只负责告诉你「缺什么、补它值不值」。
`comfy_health` 返回同一份清单的精简版。

## 更新记录

- **0.3.5** —— 按 **H3 官方协议**重做提示词这一层，并修两个会误伤长任务的缺陷（回归：unit 69/69）。
  - **找到根因**：`prompts/h3-r2v-提示词格式.md` 原来是从两份样本**反推**的，不是从规范来的。
    拉到官方 `skills/h3-prompt-writing/references/{base-en,ref-en}.txt` 逐条对照后，14 项里
    **7 项冲突、4 项缺失**，其中最要命的是把 `overall_soundscape` 写成了「逐镜音效清单」
    —— 官方明说那一段是**整段声学概括**，逐镜同步音效必须留在正文。另有对白层
    （`(S1)` / `<d>` / `<scenetrans>` / `<cutoff>`）、参考音频 `<Audio N>`、图片对齐指令行**整层缺失**。
    详见 [`docs/H3-官方协议对齐报告-2026-11-06.md`](docs/H3-官方协议对齐报告-2026-11-06.md)。
  - **`mcp/lib/h3protocol.mjs`**：结构校验器，只判断结构、不解读内容、不回灌正文。
    查字段名与顺序、首镜不写时间码、后续 `At MM:SS.mmm` 严格递增、`<d>` 成对、
    声源按首次发声顺序编号、参考标签必须先定义、retention 标记合法、两条声音字段的职责边界、
    禁止 `negative` 字段。报错只带**位置与形状**。
  - **`mcp/lib/h3refs.mjs`**：`<Picture n>` 编号从 API 图**按执行顺序**数出来
    （`MiniMaxH3ImageToVideo` → `first_frame,last_frame`；`MiniMaxH3ReferenceToVideo` → `ref_image_N`）。
    只跟随单图操作；遇到开关/批量标 unresolved；**同一张图被两槽使用 → 返回 undefined，不猜**。
  - **提交前拦截**：`comfy_video` 的 `start` 现在先跑结构校验，error 级直接拦下、**不发起执行**，
    按字段位置列出问题让 agent 自己改；要照旧提交传 `allow_invalid_prompt=true`。
    理由是 ComfyUI 的 `POST /prompt` 只校验节点/必填/类型，提示词写错它一句话不说。
  - **缺席 ≠ 失败**：`waitFor` 原来「既不在队列也不在 history」就抛错，把正常任务误判成失败。
    现在只有「从没出现过 + 过了宽限期」才报错；「出现过又不见了」按保守判据继续观察
    （任务 ≥30 分钟 + 连续 6 次**有效**观测 + 跨度 ≥2 分钟），等不到返回 `notObserved` 而不是抛错。
  - **`/queue` 不再整包拉**：响应里带着每个排队任务的完整工作流（几 MB），现在只取 id 与在场状态，
    按 1 秒 TTL 共享同一次读取；凭据只作为内存缓存键，不落盘。
  - **`prompts/h3-r2v-提示词格式.md` 重写**：以官方为准，样本降级为实例，凡是我们自己的经验都标【工程】。
- **0.3.4** —— 修一条**只在别人机器上**才出现的问题，外加三件让工作流本身可维护的工具（回归：unit 29/29）。
  - **跨机器的面板渲染失败**：`cordis.patch.yml` 里写死了开发机的 `comfyRoot` / `projectRoot`。换台机器这两条
    「格式合法但不存在」，于是 `runs/live`、`workflows/`、`.cache/client-diag.log` 全落在空气里 ——
    面板起来是空壳，**诊断日志自己也丢**，界面上一点痕迹都没有。DSH 只会说 `{slot} 渲染失败：`，
    而它把「没装上」和「装上了、然后抛了」分得很清，这句属于后者。
    现在：路径留空自动探测（`projectRoot` 回退到插件目录上一级、`comfyRoot` 从 `/system_stats` 的 `argv[0]` 反推）；
    配置里写了但**不像本仓库**（没有 `mcp/server.mjs` 也没有 `workflows/`）就忽略并回退；
    `noteOrigin()` 改用它解析后的路径（原来用原始配置值，那个文件也写丢了）；
    前端 `diag()` 写不回 Host 时不再静默 —— 内存留一份 + 控制台喊一句，`window.__COMFY_LIVE_DIAG__` 可查。
    新增 `tools/plugin-doctor.mjs`：11 项检查一条命令给结论。
  - **`mcp/lib/uitograph.mjs`**：API 图 → UI 图的转换原来有两份实现（插件里一份、`to-ui-workflow.mjs` 一份），
    现在合成一份并在转换后自检（widget 位序、连线两端、节点类型是否都在 `/object_info` 里）。
  - **`tools/publish-workflows.mjs`**：「我说存好了」和「你在 ComfyUI 侧边栏看得见」是两件事 ——
    模板在 `workflows/`（API 格式），侧边栏只读 `<ComfyUI>/user/default/workflows/` 且要 UI 格式。
    这个脚本负责那一节：固定几份、中文名带编号、转换前先按 `defaults` 填好真实提示词。
  - **`tools/workflow-diff.mjs`**：逐节点对比两份工作流，抓「改了但没人告诉你」的静默差异
    （`POST /prompt` 只校验节点类型/必填/类型，查不出接错槽、悬空节点）。严重度 `slot > input > value > weak`。
  - **`tools/cleanup.mjs`**：分三档清派生垃圾（缓存 / 重复落盘 / 实验产物），默认 dry-run，只动可重算的东西。
  - **视频音频是谐波不是声音**（根因）：二采用独立的 `BasicScheduler(steps=4, denoise=0.35)` 会把 35% 噪声
    重新灌进整个 AV latent，音频被毁、只剩 1230Hz 整数倍谐波。改用 `SplitSigmas` 8+4 后过零率 0.013 → 0.063，
    与用户自己的成片（0.045–0.122）同档。这条**连续误判了 4 次**才定位，过程写进 `docs/journal/BUGLOG.md`（不入库）。
  - 新模板：`moss_t2i` / `krea2_t2i` / `flux2_t2i` 三套文生图，以及 `threeview_flux2` ——
    **一条工作流**出正/侧/背三视图并用 `ImageStitch` 拼成 2496×1216（三条采样链共享同一个 `RandomNoise`）。
- **0.3.3** —— **纯结构重构，行为不变**（回归：selftest 80/80、unit 21/21）。
  `server.mjs` 从 2,100 行拆成 81 行装配层 + `mcp/tools/` 下 6 个域文件（system / generate / view / edit / library / media）
  加一个 `ctx.mjs` 共享上下文。注册点数仍是 33，`server.mjs` 里 0。
  拆分由脚本按括号匹配机械搬移，逻辑一行未改。详见 [`docs/TOOL-AUDIT.md`](docs/TOOL-AUDIT.md) 的 P0（那条挂了很久）。
  顺带修：版本号改为从 `package.json` 读（原来在 `ctx`/`selftest` 里各写死一份，发版必漂移）。
- **0.3.2** —— 把「已知问题」里能修的都修了（都是小改动，但每一件都带判定依据）：
  - **`flickerNoCut`**：切点前十帧的差分天然极大，用 `flicker` 排序会系统性压分多镜头候选。
    现在剔除切点前后 2 帧再算一次，`score` 默认用这个口径（实测 A 六镜 8.402 → 7.582，B 一镜不变）。
  - **`tools/model-slots.mjs`**：模板钉死的模型文件名在不同机器上往往不同。这个工具按「槽位 → 角色目录」找等价物，
    给候选（同扩展名优先，`.gguf` 不会配给 `.safetensors`），但**不自动替换**——换错模型比报错更糟。
  - **`tools/watchdog.mjs`**：ComfyUI 存活看门狗，**只看只报，不杀不拉起**。记录失联/恢复时长、显存余量、
    疑似卡住（running 长时间不变且 pending>0），并给出人可直接复制的下一步命令。
  - **`comfy_triage` 认视频**：大小 / 时长 / 读不出三类硬缺陷，坏文件照样进 `_trash` 可 restore。
  - **`preflight` 加体积校验 + 来源/许可**：0 字节占位文件、下到一半的残文件不再「通过」；
    缺件时给出从哪拿、什么许可。
  - **`tools/clip-score.mjs` 转正**：从 `experiments/` 移出来，去掉本机路径，参考图必须显式给。
  - **`mcp/test/unit.mjs`**：21 项纯函数单测（帧数换算、模型槽、体积校验、类型抽取、家族/桶、视频分拣），
    和端到端 `selftest`（80 项）分开跑。
- **0.3.1** —— 修 P0：**remote 模式（不设 `comfyRoot`）下整个 MCP 服务启动即崩**。
  `mcp/lib/workflowcheck.mjs` 顶层 `path.join(null, …)` 在 ESM 链接阶段抛 `TypeError`，工具一个都注册不上。
  现在一律判空，并且 `comfy_check_workflow` 会明说「remote 模式下 A 档/D 档不可判，结论只覆盖 B/C 档」，不再静默给错结论。
  新增第 13 组回归用例（5 条），并把 bug 注回去验证过它确实会红。
  README 工具数 32 → **33**（`server.tool(` 实测 33 处），`mcp/README.md` 补齐 5 个缺失条目。
- **0.3.0** —— 首个公开版本。

> 这个 P0 是**外部审查发现**的。它值得写在这，因为它暴露的是共性问题：
> **开发机上永远走不到的路径（比如本机没装 ComfyUI 的 remote 模式），必须由测试代跑。**
> 我在自己机器上有 ComfyUI，`COMFY_ROOT` 永不为 null，所以这条路我一次都没走过。

## 许可

**MIT**，见 [`LICENSE`](LICENSE)。

本仓库**不含**任何模型权重、ComfyUI 本体或 Python 运行时。随仓库分发的只有源码、工作流 JSON（纯 JSON，不含权重）、
文档与提示词模板。你用到的 ComfyUI、FLUX / SDXL / MiniMax H3 等组件各自遵循其发布方许可，与本仓库的 MIT 授权无关——
再分发前请自行核对。

如果这个项目帮到了你，请在 issue 里告诉我你卡在哪一步，那比 star 有用。
