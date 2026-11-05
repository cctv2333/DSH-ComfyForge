# 给 AI 的安装与环境指南

> **这份文档的读者是 AI，不是人。**
> 它的目标：把你这套工具装到一台**你没见过的机器**上，并且让它跑起来。
> 人类的 ComfyUI 环境千差万别（便携整合包 / 源码安装 / 远程服务 / 甚至没有），
> 所以这里不给"一键脚本"，给的是**判定链**：每一步怎么查、查到了什么算过、不过怎么修。

---

## 0. 三条铁律（违反任何一条，后面都会更糟）

1. **先诊断，后动手。** 任何一步在没拿到证据前，不要执行安装、不要改配置、不要杀进程。
2. **不许静默降级。** 做不到就说做不到，并给出下一步；**最坏的行为是"看起来成功、其实功能缺失"**。
3. **不自动下载大文件。** 权重、整合包、模型都不许你擅自下。你的职责是**说清楚缺什么、多大、放哪、从哪拿**，然后让人类决定。

> 第三条不是胆小。权重动辄 6–50 GB，下错一遍就是几小时；而且它们各有各的许可协议。

---

## 1. 第一步永远是这一个命令

```bash
node mcp/doctor.mjs --json
```

它会在**不依赖 ComfyUI 的情况下**检查：配置文件、运行模式、ComfyUI 连通、产物目录、日志、Python（真跑一次 import）、缓存可写、
以及每个模板引用的模型文件在不在。

读它的返回，把问题归类到下面五种之一，然后只修那一类：

| 类别 | 判据 | 去哪一节 |
|---|---|---|
| 没 Node / 版本太低 | 命令直接跑不起来 | 第 2 节 |
| ComfyUI 不通 | `comfyui` 这项 fail | 第 3 节 |
| Python 缺库 | `python` 这项 fail | 第 4 节 |
| 缺节点包 | `comfy_check_workflow` 报 A/B 档 | 第 5 节 |
| 缺模型权重 | `models` 这项 fail | 第 6 节 |

---

## 2. Node 与 ffmpeg

**需要 Node ≥ 20**（用到内置 `fetch`、`AbortSignal.timeout`）。

```bash
node -v
```

**ffmpeg** 只有视频/音频相关功能需要，但它是硬依赖（`shots`、`videoMetrics`、拼图、混音全靠它）：

```bash
ffmpeg -version
```

判据：能用 `ffmpeg` 或设 `FFMPEG_PATH` 指向可执行文件。没有它，**出图工具照常工作**，只是视频类工具会报错——
这不是故障，是缺件，要如实告诉人类。

---

## 3. ComfyUI：先判断它是哪一种形态

不要假设它在哪。按顺序判：

```bash
curl -s http://127.0.0.1:8188/system_stats
```

| 结果 | 形态 | 你该做什么 |
|---|---|---|
| 返回 JSON，含 `system.argv` | **已在运行** | 从 `system.argv[0]` 反推 `main.py` 的绝对路径 → 那就是 `COMFY_ROOT` 的上一层 |
| 连不上 | 没在跑 | 问人类或找目录，见下 |

**找安装目录的有界做法**（别全盘递归）：

1. 先问环境变量：`COMFY_ROOT`；
2. 再看常见位置：`*ComfyUI*/`、`*ComfyUI*/ComfyUI`、`*整合包*/ComfyUI`；
3. 判据是**同时存在** `main.py`、`custom_nodes/`、`models/` 这三样；
4. 找到了就写进配置：`{"comfyRoot": "<那个目录>"}` 保存为 `comfyforge.config.json`。

### 两种模式，能力不同（必须显式告知人类）

| 模式 | 条件 | 能做什么 | 不能做什么 |
|---|---|---|---|
| **local** | 有 `comfyRoot` | 全部：读日志、直读产物、扫 `custom_nodes`、检查工作流缺件分 A/B/C/D 四档 | — |
| **remote** | 没有 `comfyRoot`，只有 `COMFY_URL` | 提交、等待、取产物（走 HTTP `/view`）、看队列 | **读不到日志**、**判不了 A 档**（已装未加载）、**判不了 D 档**（前端节点）、没有本地原图捷径 |

> remote 模式下 `comfy_check_workflow` 会明确打印「A 档与 D 档无法判定」。看到这行不要试图"绕过"，
> 那是事实，不是缺陷。想变完整就把 `comfyRoot` 补上。

---

## 4. Python（图像运算）

只用于 Pillow + numpy 的图像运算（指标、拼图、蒙版）。**不需要和 ComfyUI 同一个 Python。**

```bash
python -c "import PIL, numpy; print('ok')"
```

- ComfyUI 便携包自带的 `python/python.exe` 通常已经装好，优先用它；
- 没有就指定：`COMFYFORGE_PY=/path/to/python`；
- 判据：`node mcp/doctor.mjs` 的 `python` 项会**真跑一次 import**，不是只看文件在不在。

---

## 5. 自定义节点包

```bash
node tools/check-workflow.mjs workflows/flux_t2i.json
```

返回里每个缺失项分四档，**只处理 A 和 B，C 靠人，D 不用管**：

| 档 | 含义 | 处理 |
|---|---|---|
| **A 已装未加载** | 目录在 `custom_nodes/`，节点不在 `/object_info` | **重启 ComfyUI**（不是重装） |
| **B 未安装** | 目录不存在 | 装这个包；返回里带 GitHub 地址 |
| **C 来源未知** | 本地映射表也查不到 | 让人类确认是哪个包 |
| **D 前端节点** | 只有 JS 注册，没有 Python 类（rgthree 的 `Label` 等） | **正常现象，不用管** |

装包的判据始终是：**`/object_info` 里出现了它该提供的节点**，不是"目录存在"。

---

## 6. 模型权重：这是最容易出问题的一节

### 6.1 为什么"照模板里的文件名下载"会失败

仓库里的模板（`workflows/*.json`）为了可复现，**钉死了确切的模型文件名**，例如：

```
flux1-dev-Q4_K_S.gguf
waiNSFWIllustrious_v130.safetensors
hassakuHentaiModel_v13.safetensors
```

但**别人的机器上文件名很可能不同**：同一个模型可能有 `-fp16` / `-int8` / 不同发布者改的名字、
或者放在 `models/unet/` 而不是 `models/diffusion_models/`。

**后果**：提交时不报"文件不存在"，而是报一堆看不懂的 `node_errors`；人以为是代码坏了。

### 6.2 所以你要做的不是"下载那个文件名"，而是"找到等价物"

按这个顺序：

1. **列出本机真实有什么**：`comfy_models`（`action=list`）或直接列 `models/<子目录>/`。
2. **按角色匹配，不按名字匹配**。角色 → 目录 → 判据：

   | 角色 | 目录 | 判据 |
   |---|---|---|
   | 主模型（SDXL/Illustrious 系） | `checkpoints/` | `.safetensors`，数 GB |
   | 主模型（FLUX GGUF） | `unet/` | `.gguf` |
   | 主模型（H3 视频） | `diffusion_models/` | 19 GB 级的 `minimax*h3*` |
   | 文本编码器 | `text_encoders/` 或 `clip/` | `clip_l` / `t5xxl` / `qwen3vl` |
   | VAE | `vae/` | `*ae*` / `*vae*` |
   | LoRA | `loras/` | 加速/风格用 |

   `mcp/lib/requires.mjs` 里的 `CAPABILITIES` 就是这么定义的（按正则匹配，不按名字），可以直接读它当权威清单。
3. **替换，而不是报错**：把模板里的文件名字段改成本机实际存在的等价文件，**并把这次替换明确告诉人类**
   （换了哪个、为什么换、可能有什么后果）。
4. 一个都找不到 → 进 6.3。

### 6.3 缺权重时怎么跟人类说

给这四样，缺一样人类就没法决策：

- **是什么**（角色，不是文件名）
- **多大**
- **放哪个目录**
- **从哪拿**（仓库/发布页；**不要替人类下**）

本仓库的 `docs/能力边界.md` 和 `preflight` 的 `minimal` / `degrade` 字段就是为这件事准备的。

### 6.4 没有权重也能先跑起来的部分

不要因为"缺 50GB 权重"就说"跑不起来"。以下**零权重**可用：

| 能力 | 需要什么 |
|---|---|
| 工作流体检（缺件分档） | 只要 ComfyUI 在跑 |
| 提示词体检 `comfy_lint_prompt` | 只要 Node |
| 视频指标 / 分镜切分 `shots` | 只要 ffmpeg |
| 能力清单 / 依赖诊断 | 只要 Node |

先交付这部分，再谈补权重。

---

## 7. 验收：必须逐条过，不许跳

```bash
node mcp/doctor.mjs                     # 8 项环境检查
node mcp/test/selftest.mjs              # 80 项协议/工具/崩溃回归
node tools/preflight.mjs                # 能力三态（ok / unknown / missing）
```

三条都过之后，再做一次端到端最小验证（**用最小参数，别一上来跑 15 秒视频**）：

```bash
node tools/storyboard.mjs --shots <镜头表> --char <角色设定> --out .cache/smoke   # 只出提示词，不跑 GPU
```

最后才提交一次最小生成（例如 5 帧 320×192、2 步），确认产物真的落盘。

---

## 8. 常见失败模式（现象 → 根因 → 修法）

| 现象 | 根因 | 修法 |
|---|---|---|
| `TypeError: The "path" argument must be of type string. Received null` | remote 模式下有代码裸用 `COMFY_ROOT`（已在 0.3.1 修） | 升级到 ≥0.3.1，或设 `COMFY_ROOT` |
| 配置改了但"没生效" | 配置文件带 **BOM**，`JSON.parse` 失败后静默退回自动探测 | 用不带 BOM 的 UTF-8 重写 |
| 中文文件被读成乱码 | 用 `Get-Content` 之类的 GBK 解码读了 UTF-8 | 用能指定 UTF-8 的方式读；**读不会毁文件，写才会** |
| 提交报一堆 `node_errors` | 缺节点包，或模型文件名/目录不对 | 先 `check-workflow`，再按第 6.2 节按角色匹配 |
| 出图工具报 Python 错 | Pillow/numpy 不在那个 Python 里 | 设 `COMFYFORGE_PY` |
| 跑到一半卡住/显存 OOM | 8GB 显存下连发任务会碎片化 | 串行；卡死后重启 ComfyUI |
| 工具调用"超时"但队列还在跑 | 设计如此（客户端约 60s 超时） | 用等待类工具接力，别把 `wait_s` 调大 |

---

## 9. 你不该做的事

- 不要为了"让它先跑起来"而**删除模板里的校验**或**把缺失项当成功**。
- 不要 `git reset --hard`、不要删人类的 `custom_nodes`、不要杀 ComfyUI 进程（除非人类明确要求）。
- 不要把占位符（`<改成你的目录>` 之类）当合法路径写进配置——**它会被当成真路径，然后静默失效**。
- 不要一次跑长时间任务之前不告诉人类「要占多久、会不会挤掉别的任务」。

---

## 10. 判断"装好了"的唯一标准

不是"命令没报错"，而是：

1. `doctor` 8 项全过；
2. `selftest` 80/80；
3. `preflight` 里**你想用的那项能力**是 `ok`（不是 `unknown`）；
4. 实际跑出一次产物，并且你能说清它落在哪个路径。

四条缺一条，就不算装好。
