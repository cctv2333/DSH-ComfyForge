# ComfyForge MCP v0.2.0（comfy-forge）

把本机 ComfyUI 变成 agent 能**看见自己产出**的作图工具。核心不是「能出图」，而是
**出图 → 客观质检 → 一次看多张 → 按证据改参数再跑**这个闭环。

> 安装前提、外部依赖、机器相关配置、能力边界：先看仓库根目录的 [`../README.md`](../README.md)
> 的「使用前必读（Critical Context）」。本文只讲工具语义与设计。

- 传输：stdio（MCP 官方 SDK 1.30，JSON-RPC 换行分帧）
- 目标：`http://127.0.0.1:8188`（`COMFY_URL` 或 `comfyforge.config.json` 可改）
- 33 个工具；图像运算走本地 Python 的 Pillow + numpy（自动挑选，不写死路径）

## 挂载

DSH（写进 `~/.dsh/profiles/<profile>/cordis.patch.yml`，**重启 DSH 生效**）：

```yaml
- insert:
    - id: mcp-comfyforge
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: comfy
        transport: stdio
        command: node
        args:
          - <仓库目录>/mcp/server.mjs
        env:
          COMFY_URL: http://127.0.0.1:8188
```

其他 MCP 客户端（Chatbox 等）：同样 stdio，命令 `node`，参数 `<仓库目录>/mcp/server.mjs`。
注意 Chatbox 的 MCP 实现较旧，对 image content 与长任务的容忍度差，不建议作为主入口。

挂之前先自查环境（不依赖 MCP 宿主）：

```powershell
cd <仓库目录>
node mcp/doctor.mjs        # 配置来源/ComfyUI 连通/模型是否齐/Python/目录权限
```

命令行自测：

```powershell
cd mcp
node test/selftest.mjs   # 68 项：协议/校验/取图/快照/崩溃回归，约 15s，不入队
node test/smoke.mjs      # 真实出图一次（4 步，约 20s），验证主链路
node test/e2e.mjs --sizes 512x512,768x768,1024x1024   # 分辨率对比 + 联络表
```

## 工具

| 工具 | 用途 |
|---|---|
| `comfy_health` | 版本/GPU/显存/队列/日志最近报错。开工先跑 |
| `comfy_models` | 本机真实可见的 GGUF/UNET/VAE/CLIP/LoRA/放大模型 + 每个模型的档案 |
| `comfy_run` | 校验 → 提交 → 等一小段 → 取图 → 算指标 → 附图。默认等 40s，超了返回 `pending` |
| `comfy_batch` | **多 seed 批量**：一次提交多张，返回每张状态与已完成联络表 |
| `comfy_wait` | 继续等某个 prompt_id（每次最多 55s，支持 8 位短 id） |
| `comfy_wait_many` | 同时等一批 prompt_id |
| `comfy_queue` | 看队列 / 取消 / 清空 |
| `comfy_image` | 取单图 + 指标（带斜杠的 filename 会自动拆成 subfolder） |
| `comfy_snapshot` | **快照**：最近 N 张或指定几张 → 一张带编号/尺寸/锐度/判定的联络表 |
| `comfy_inspect` | 只做客观体检（分辨率/锐度/裁切/对比/九宫格），不给图 |
| `comfy_profile` | 模型档案：原生分辨率、宽高比桶、是否可用（list/get/set） |
| `comfy_picks` | 精选清单：我挑的 / 你看板里点的，同一份数据 |
| `comfy_templates` | 模板库 list/get/save/delete（纯 JSON，可手改） |
| `comfy_runs` | 最近运行记录（工作流+参数+产物+判定） |
| `comfy_lessons` | 本地经验库：remember/recall/stats（跨会话） |
| `comfy_log` | 日志尾部 / 只看报错 / 最后一段 Traceback + 建议 |
| `comfy_nodes` | 查节点定义 / 按名字类别搜节点（拼新工作流时用） |
| `comfy_edit` | **局部重绘 / img2img**：给图 + 区域只改那块；返回蒙版内外改动比例 |
| `comfy_upload` | 把本地图上传到 ComfyUI input（img2img / inpaint 前置） |
| `comfy_look` | 整体看：缩到 900px，可加坐标网格（先看气质，别一上来抠细节） |
| `comfy_region` | 局部看：按原图坐标裁一块放大（手/脸/文字/接缝） |
| `comfy_workflows` | **看别人的工作流**：列出 ComfyUI 保存的 workflow、拆出节点/模型/输入、判断缺哪些插件，并写 Markdown 说明 |
| `comfy_composite` | 把「参考渲染」按 box 贴进底图（羽化），用于分开渲染再合成 |
| `comfy_place` | **放置物体**：控制画布 + 蒙版，把参考物体放进场景的指定位置 |
| `comfy_replace` | **换物体（先擦后画两遍法）**：先把区域擦成背景，再用控制图画新物体；分阶段可续等 |
| `comfy_restructure` | **全局重构**：场景边缘 + 物体边缘当控制图，从空 latent 整张重画（局部改不动时用；见 BUG-0018） |
| `comfy_triage` | 淘汰：只按客观缺陷判定，移入 `_trash` + manifest，可 restore |
| `comfy_journal` | 工作 / Bug 日志：写进 `docs/journal/`，可 list / search |
| `comfy_activity` | 「我刚才做了什么」：最近 N 次工具调用（耗时/成败/返回摘要/附图） |
| `comfy_video` | **视频**：`start`/`status`（可就地续等）/`frames` 抽帧/`sheet` 拼图/`metrics` 客观指标 |
| `comfy_sweep` | **分辨率试错**：同 seed 同提示词跑一组尺寸，按客观指标排序找原生桶 |
| `comfy_check_workflow` | **工作流体检**：给 `path` 或 `json`，分 A/B/C/D 四档报缺件（remote 模式下会明说 A/D 档不可判） |
| `comfy_lint_prompt` | **提示词体检**：纯规则、毫秒级、不联网；查段落/引用闭合/时间码/帧数 5+17k/手分工 |

## 工作与 Bug 日志（写在工具里）

- `docs/journal/WORKLOG.md`：做过什么，一条一个 `WORK-nnnn`
- `docs/journal/BUGLOG.md`：踩过什么坑、根因、怎么修，一条一个 `BUG-nnnn`（状态 open/fixed/wontfix）

```text
comfy_journal(action="bug", title="...", body="现象/原因/改法/证据", status="fixed")
comfy_journal(action="list")
comfy_journal(action="search", query="controlnet")
```

## 模型档案（分辨率跟模型走，不跟模板走）

`../models.json` 给每个模型登记：家族、原生像素量、**宽高比桶**、步数/cfg 参考、是否可用。

```json
"flux1-dev-Q4_K_S.gguf": { "family": "flux", "usable": true },
"flux1-dev-bnb-nf4-v2.safetensors": { "family": "flux", "usable": false, "reason": "0.30.2 无 bnb 代码路径" }
```

- 尺寸命中桶 → `hints` 里说「命中 1344x768（1.03MP）」；
- 尺寸不在桶里 / 低于原生一半 → `warnings` 说清差在哪；
- 模型被标 `usable:false` → 提交前直接拒绝。
- 新模型：`comfy_profile(action="set", model="xxx.safetensors", profile={"family":"sdxl"})`。

## 看板（看得到我在干什么）

```powershell
cd <仓库目录>
node ui/server.mjs        # http://127.0.0.1:8790
# 或双击 start-dashboard.cmd（可带端口参数）
```

- 每次运行一张卡：提示词、模板、尺寸、seed、步数、耗时；
- 每张图带判定徽章（OK/WARN/RISKY）与 sharp512；
- 点 ★ 选中 → 写入 `../picks.json`，我下次就能读到你挑的是哪张；
- 顶部「精选」区就是当前选中的图；
- 不在 `runs/` 里的历史图会以「未归档」出现，不会消失。

## 为什么这样设计（都是踩出来的）

1. **单次调用必须 < 60s**。MCP 客户端（含 DSH）默认请求超时 60s。实测 1024×1024 FLUX
   约 60–90s，v0.1 的「阻塞等 300s」必然表现为调用失败。现在 `comfy_run` 只等 40s，
   超时返回 `pending + prompt_id`，由 `comfy_wait` 接力——长任务因此不会「失败」。
2. **图片文件名的 subfolder 必须拆开**。`filename="comfyforge/out_00001_.png"` 直接传给
   `/view` 是 404（v0.1 的 `comfy_wait_result` 正好返回这种带斜杠的路径，取图必挂）。
3. **提交前静态校验**。用 `/object_info` 查每个 `class_type` 是否存在、必填输入是否齐全、
   连线是否断、枚举值是否在可选项里；再叠加本机实测过的坑（bnb nf4 不可用、
   UnetLoaderGGUF 只能吃 .gguf、FLUX cfg=1 时负向提示词无效、<1MP 细节必掉）。
   坏工作流在提交前就被挡住，而不是等 20 秒后报一句 `execution error`。
4. **失败必须说清哪一步**。`/history` 的 `node_errors` / `status.messages` / 日志
   Traceback 都会解析出来，并附可执行建议（OOM→降分辨率，shape mismatch→VAE 不配套…）。
5. **「看」不能只给 base64**。客观指标（`lap_var_512` 跨分辨率可比的锐度、边缘密度、
   裁切比例、九宫格局部锐度）+ 一张联络表，让视觉模型一次比较一批图；审美判断交给
   视觉模型自己看，工具只给证据。

## 模板与调参

### 三个模板，三种改图方式

| 模板 | 链路 | 什么时候用 |
|---|---|---|
| `flux_t2i` | GGUF → 双 CLIP → EmptyLatent → KSampler → VAE → Save | 从零生成 |
| `flux_img2img` | LoadImage → VAEEncode → KSampler(denoise 0.25–0.45) | 构图满意，精修质感/细节 |
| `flux_inpaint` | LoadImage + LoadImageMask → VAEEncode → SetLatentNoiseMask → KSampler(0.65–0.8) | 只改一块（手、杯子、招牌、加物件） |

局部重绘的验收是可量化的：`comfy_edit` 返回 `locality`，蒙版内应大改、蒙版外应接近 0
（实测一次：蒙版内 68.65%，蒙版外 1.06%）。

模板在 `../workflows/*.json`：

```json
{
  "name": "flux_t2i",
  "bindings": { "prompt": ["4","text"], "width": ["7","width"], "seed": ["8","seed"] },
  "defaults": { "width": 1024, "height": 1024, "steps": 20, "guidance": 3.5 },
  "workflow": { "1": { "class_type": "UnetLoaderGGUF", "inputs": { ... } } }
}
```

- `bindings`：参数名 → `[节点id, 输入名]`，`comfy_run(params={...})` 时写进去。
- `randomize: ["seed"]`：不传 seed 时自动随机（否则每次同一张）。也可显式传 `seed: null`。
- 也可在字符串里写 `{{prompt}}` 占位符。
- 直接改 JSON 即可；`comfy_templates get/save` 可在对话里改。
- FLUX 推荐尺寸（原生约 1MP）：`1024x1024`、`1344x768`、`768x1344`、`1152x896`。

> 模板文件每次调用都会重新读盘，改完立刻生效；**但 `lib/` 或 `server.mjs` 的代码改动要重启
> DSH**（stdio 进程是常驻的，改配置里的 env 也不会自动重启已有实例）。

## 目录

```
mcp/
  server.mjs          32 个工具与协议接线
  lib/comfy.mjs       HTTP、提交、等待、错误翻译
  lib/video.mjs       H3 图生视频：工作流组装 / 提交 / 续等 / 抽帧拼图
  lib/workflowcheck.mjs 工作流缺件体检（A/B/C/D 四档）
  lib/templates.mjs   模板解析/校验/运行记录
  lib/img.mjs         Python 桥：指标/拼图/缩略图
  lib/diag.mjs        日志与 Traceback
  lib/memory.mjs      经验库（JSONL）
  scripts/imgops.py   度量与联络表（Pillow + numpy）
  test/*.mjs          自测 / 冒烟 / 对比
../workflows/         模板（可手改）
../runs/              每次运行的快照（JSON）
../.memory/           经验与运行摘要（JSONL）
```

## 已知限制

- 8GB 显存：1024×1024 能跑但偏慢（约 60–90s），并发会 OOM；`comfy_health` 会看空闲显存。
- `t5xxl_fp16`（9.3GB）超显存，ComfyUI 自动放 CPU，编码慢；换 `t5xxl_fp8` 可加速。
- 没有放大模型（upscale models 目录为空），超分只能靠第二次采样或后处理。
- 审美/语义好不好，工具判断不了——必须看图，`comfy_snapshot` 就是为这个存在的。
