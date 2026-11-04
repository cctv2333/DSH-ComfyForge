# ComfyForge v0.2 重建报告

- 日期：2026-11-03
- 目标机器：ComfyUI 0.30.2（`<DEV>\ComfyUI-aki-v3.2`），RTX 5060 Ti 8GB，16GB 内存
- 前作：`mcp/server.mjs` v0.1（Chatbox agent 写的 6 工具版本）
- 本次结论：**v0.1 有 4 个会直接导致「接不上/各种失败」的硬 bug；已重写为 12 工具的 v0.2，47 项自测 + 冒烟 + 三档分辨率实测全过，并已在 DSH 内实测出图成功。**

---

## 1. 先说 v0.1 到底坏在哪（都有复现证据）

### BUG 1（致命）等待结果后取不到图 —— 404
`comfy_wait_result` 返回的是 `comfyforge/selftest_00001_.png`（子目录被拼进了文件名），
而 `comfy_get_image` 把它整个当 `filename` 传给 `/view`。

实测：

```
/ view?filename=comfyforge%2Fselftest_00001_.png&subfolder=  -> HTTP 404
/ view?filename=selftest_00001_.png&subfolder=comfyforge     -> 200
```

也就是说：**生成成功了，链路断在最后一步**。这才是「明明能跑，但一取图就失败」的根因。
（ComfyUI 的 `/view` 只接受纯文件名，目录必须走 `subfolder` 参数。）

### BUG 2（致命）stdin 关闭时进程崩在 libuv 断言
v0.1 在 `finally` 里调 `process.exit(0)`，Windows 管道上 stdout 还有未刷新的写入：

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
[exit code: 1]
```

客户端侧看到的就是「服务器无响应/进程退出」。v0.2 去掉了所有 `process.exit`，实测 EOF 后
退出码 0、stderr 干净（这是自测第 11 项，专门做的回归）。

### BUG 3（致命，设计层面）阻塞等待 300s，必然撞客户端 60s 超时
MCP 客户端（官方 SDK，DSH 同源）单次请求默认超时 **60 秒**。实测 1024×1024 FLUX 要
60–90 秒，v0.1 的 `comfy_wait_result(timeout_s=300)` 在客户端看来就是：

```
McpError: MCP error -32001: Request timed out
```

服务器其实还在跑，但调用方已经认定「失败」——这正是你说的「各种各样的失败」的来源。
v0.2 改成：`comfy_run` 只等 40s（上限 55s），没跑完返回 `pending + prompt_id`，
由 `comfy_wait` 接力。1024 实测 59.5s、需要 1 次接力，链路稳定。

### BUG 4（质量）512×512 当默认，且从不看图
- 自测产物 `selftest_00001_.png` 实际是 **512×512**（0.26MP），而 FLUX 原生约 **1MP**。
- 报告里写「768×768×20 步 ≈50s」，但自测图是 512，也没说明 512 低于原生分辨率。
- 全流程没有任何图像质量检查：没有分辨率检查、没有锐度、没有看图判断。
  512 那张的机器人**手部结构是糊的、水从手掌里喷出来**，1024 那张手拿水壶、结构光影都正常
  （对比图见 `.cache/sheets/compare.jpg`，本报告第 4 节有结论）。

### 其他问题
- 所有 `fetch` 没有超时：ComfyUI 卡住（加载大模型时常见）就永久挂起。
- 执行失败只回一句 `execution error`，不解析 ComfyUI 的 `node_errors`、不看日志 Traceback。
- FLUX `cfg=1.0` 时负向提示词**完全不生效**，v0.1 仍保留负向分支并接受 `negative` 参数，误导使用者。
- `comfy_list_models` 读的是节点「可选项」而不是磁盘上的真实文件，容易给出不存在的名字。
- 没有静态校验：未知节点、缺必填输入、断连线都要等提交后由 ComfyUI 报错。

---

## 2. v0.2 做了什么

12 个工具，核心是让 agent **看得见自己的产出**：

| 工具 | 作用 |
|---|---|
| `comfy_health` | 版本/GPU/显存/队列/日志最近报错 |
| `comfy_models` | 本机真实可见模型（GGUF/UNET/VAE/CLIP/LoRA/放大）+ 模型档案 |
| `comfy_run` | 校验 → 提交 → 等 40s → 取图 → 算指标 → 附图；未完成返回 pending |
| `comfy_batch` | 多 seed 批量提交，返回每张状态与已完成联络表 |
| `comfy_wait` | 接力等待（每次 ≤55s，支持 8 位短 id） |
| `comfy_wait_many` | 同时等一批 prompt_id |
| `comfy_queue` | status / cancel / clear |
| `comfy_image` | 取单图 + 指标（自动拆 subfolder） |
| `comfy_snapshot` | **快照**：N 张 → 一张带编号/尺寸/锐度/判定的联络表 |
| `comfy_inspect` | 纯客观体检（分辨率/锐度/裁切/对比/九宫格） |
| `comfy_profile` | 模型档案：原生分辨率/宽高比桶/可用性（list/get/set） |
| `comfy_picks` | 精选清单（与看板 ★ 按钮同一份数据） |
| `comfy_templates` | 模板库 list/get/save/delete（纯 JSON，可手改） |
| `comfy_runs` | 运行记录（工作流+参数+产物+判定） |
| `comfy_lessons` | 经验库 remember/recall（跨会话） |
| `comfy_log` | 日志尾部 / 只看报错 / 最后一段 Traceback + 建议 |

关键实现点：

1. **提交前静态校验**：用 `/object_info` 检查每个 `class_type` 是否存在、必填输入、连线、枚举值，
   再叠加本机实测过的坑（bnb nf4 不可用、`UnetLoaderGGUF` 只能吃 `.gguf`、FLUX `cfg=1` 负向无效、
   `<1MP` 细节必掉）。坏工作流在提交前就被挡住，并指出**具体节点 id**。
2. **失败可诊断**：解析 `/history` 的 `node_errors`、`status.messages` 和日志 Traceback，
   给出可执行建议（OOM→降分辨率 / shape mismatch→VAE 不配套 / 文件找不到→看 `comfy_models`）。
3. **客观图像度量**：`lap_var_512`（缩到 512 后测的锐度，**跨分辨率可比**）、边缘密度、
   裁切比例、对比、九宫格局部锐度。踩过一个坑：直接在原生像素上算拉普拉斯，
   会让 1024 图看起来「更糊」，必须归一化到同一尺寸再比。
4. **快照**：拼图 + 每格三行标签（文件名 / 尺寸·MP·sharp512·edge / 判定）。第一版标签会横向串行，
   已修（按格宽截断 + 三行）。这就是你要的「多张照片、实时看自己干活」的能力。
5. **经验沉淀**：模板（`workflows/`）、运行记录（`runs/`）、经验（`.memory/lessons.jsonl`）三层，
   都是可读 JSON，你可以直接改。

---

## 3. 测试结果（全部实测）

| 测试 | 内容 | 结果 |
|---|---|---|
| `node test/selftest.mjs` | 协议、16 个工具、坏工作流拦截、bnb 拦截、seed 随机化与 null 防护、subfolder 取图、快照、体检、模板、**模型档案/尺寸桶**、精选、批量提交、**EOF 崩溃回归** | **63/63 通过**，约 20s，不入队 |
| `node test/smoke.mjs` | 真实出图：提交 → pending → 轮询 → 成功 → 指标 | **7/7 通过**，19.9s |
| `node test/e2e.mjs` | 512/768/1024 三档对比 + 联络表 | 43.3s / 40.7s / 59.5s，risky / warn / ok |
| `node test/curate.mjs` | 批量 4 张 1344×768 + 联络表 | 全部成功，57–70s/张 |

| 分辨率 | 耗时 | 判定 | sharp512 | edge | 备注 |
|---|---|---|---|---|---|
| 512×512 | 43.3s | RISKY（below_native） | 1425 | 12.4% | 0.26MP，低于原生 |
| 768×768 | 40.7s | WARN（small） | 944 | 8.8% | 0.59MP，接近但未达 |
| 1024×1024 | 59.5s（1 次接力） | OK | 1177 | 6.1% | 1.05MP，原生 |

DSH 内实测：`comfy_run`（pending，40.4s）→ `comfy_wait` → 出图并在对话里直接返回图片，
一张 1024 的「黄铜机器人举 COMFY FORGE 木牌」，文字拼写正确、手部握持正常。

---

## 4. 看图结论（这是 v0.1 完全没做的部分）

对比图：`.cache/sheets/compare.jpg`（512 / 768 / 1024 同提示词同种子）

- **#1 512**：机器人右手与水柱糊在一起（水像从手掌里喷出），眼睛结构含糊，身体比例偏「玩具」，
  桌面薄、背景糊成一片。指标只标了 `below_native`——但真正的问题是**结构错误**，
  这是任何数值指标都测不出来的，只能看。
- **#2 768**：手指开始分开，桌面与背景有了层次，但水仍然没有「壶」这个物体，脸还是平的。
- **#3 1024**：机器人**真的握着一把浇水壶**，手指结构正确，黄铜材质有反射，桌面有厚度与投影，
  背景有窗与植物虚化，构图成立。

结论：**FLUX 在这个任务上，1MP 是分水岭；512 不只是「像素少」，是语义/结构都错。**
所以 v0.2 把「分辨率是否达 1MP」做成硬提示，并且在 `flux_t2i` 模板里默认 1024。

另外实测了一个反例，值得记住：`lap_var` 高 ≠ 好图。512 的 sharp512 反而最高（1425），
因为它像素少、边缘陡；但它内容更差。**数值指标只用来筛「糊/过曝/太小」，好不好必须看图。**

---

## 4.5 分辨率不是 1024：按模型走（用户指出后改的）

把 1024 写死在模板里是错的：FLUX 约 1MP，SDXL 也是 1MP 但桶不同，SD1.5 原生只有 0.26MP，
有的模型官方示例是 1280×768。所以新增 `models.json`：

```json
"families": {
  "flux": { "native_mp": 1.0, "buckets": [[1024,1024],[1344,768],[768,1344],[1152,896], ...] },
  "sdxl": { "native_mp": 1.05, "buckets": [[1024,1024],[1216,832], ...] },
  "sd15": { "native_mp": 0.26, "buckets": [[512,512],[768,512],[512,768]] }
}
```

校验器现在会：命中桶 → 明确说「命中 1344x768（1.03MP）」；不在桶里 → 警告并给出最接近的桶；
低于原生一半 → 警告细节必掉；模型标 `usable:false` → **提交前直接拒绝**。

本轮实测：1344×768 四张全部正常出图（1.03MP，约 57–70s/张），说明按桶走是可行的。

## 4.6 看板 + 批量挑图（「我要看到你干了什么」）

- 看板：`node ui/server.mjs` → `http://127.0.0.1:8790`
  - 每次运行一张卡（提示词/模板/尺寸/seed/步数/id/时间），图上有 OK/WARN/RISKY 徽章与 sharp512；
  - 点 ★ 选中，写入 `picks.json`；我下次读同一份文件，就知道你挑的是哪张；
  - 不在 `runs/` 里的历史图以「未归档」出现，不会凭空消失。
- 批量：`comfy_batch`（多 seed 一次提交）+ `comfy_wait_many`（同时等）→ 联络表对比。
- 本轮实跑：4 张 1344×768「黄昏工作台 + 黄铜鸟」。
  - 我的判断：**#2 最好**（主体清晰、材质与光影干净、构图集中、sharp512=430），
    **#1 次之**（场景信息最全，适合环境图）；#3 元素太杂、#4 主体太小。
  - 已把 #2/#1 写进 `picks.json`，你可以直接在看板里改。
  - 诚实记录：提示词里的 **clockwork（机械结构）没体现**，模型给的是光滑鸟形摆件。
    这不是分辨率问题，是语义遵循问题——要机械感得给结构词（exposed brass gears / rivets）
    或上参考图。已写进经验库。

## 4.7 这一轮我自己写出来的 bug（都修了）

写新功能时也翻车了几次，一并记下来：

1. `pollMany` 里用了 `sleep` 但没 import → 批量提交后立刻报 `sleep is not defined`，
   **而且此时任务已经进队列了**。修复：补 import；并且把「轮询异常」改成不吞掉已提交的 id
   （`poll_error` 字段 + 仍返回 batch），否则任务变孤儿。
2. 我把队列里的 8 位 id 前缀**手工补成完整 UUID**（猜错了后缀），`comfy_wait_many` 一直查不到、
   白等 6 分钟。修复：`historyResolved` 支持短 id 前缀匹配；`pollMany` 对「既不在队列也不在历史」
   的 id 15 秒后判为 `unknown_ids`，不再拖住整批。
3. 看板 `ROOT` 多退了一级（`ui/../..` = `D:\dev`），导致读不到 `runs/`，页面全是 0。
4. `curate.mjs` 把工具错误静默吞成空对象，表现成「提交 0 个」而不报错——现在会打印原始响应并退出 1。
5. 批量任务一开始不写 `runs/`，看板里看不到这批图。修复：批量完成后逐个落运行记录。

这些都不是「理论问题」，是实际跑出来的；每一条都补进了测试或代码路径。

## 5. 怎么用

DSH 已生效（`<USER>\.dsh\profiles\desktop\cordis.patch.yml` 里已加入 `mcp-comfyforge`，
本会话内 12 个 `comfy_*` 工具已可直接调用，无需重启）。

典型循环：

```
comfy_run(template="flux_t2i", params={prompt:"...", width:1024, height:1024})
  → 若 pending：comfy_wait(prompt_id)
  → 看附图 / comfy_snapshot(latest=4) 对比多张
  → 不满意：改 params（prompt/seed/steps）再来一轮
  → 满意的参数用 comfy_lessons remember 记下来
```

注意：**模板 JSON 每次调用都重读，改完立刻生效；`lib/` 和 `server.mjs` 的代码改动要重启 DSH。**
stdio 进程是常驻的，改配置里的 env 也不会让已有实例重启——本会话里的实例就是几分钟前的代码
（功能一致，只差「不传 seed 时自动随机」这一条）。重启后自动补齐。

Chatbox 那条路：它的 MCP 实现较旧，对 image content 和长任务容忍度差，建议不再作为主入口；
要用也只能跑 `wait_s=0` + `comfy_wait` 轮询。

---

## 6. 还没解决 / 建议

1. **出图慢的根因是 `t5xxl_fp16`（9.3GB）超显存被放到 CPU 编码**。换 `t5xxl_fp8`
   （约 4.9GB）能把编码时间砍一半以上，值得做。
2. **显存紧**：8GB 跑 1024 时模型有 ~1.1GB 被 offload，`vram_free` 常年在 2GB 上下。
   并发提交会 OOM；`comfy_health` 会给出提示，但没做自动排队。
3. **没有放大模型**（`upscale_models` 为空），超分只能靠第二次采样或外部工具。
4. **审美/语义判断**依赖视觉模型（也就是我）。工具只给客观证据；换一个没有视觉能力的
   agent，仍然会「看不见问题」——这是设计边界，不是 bug。
5. **bnb nf4 那 11.2GB 文件**：已确认不可用并已删除（证据见文末附录），D 盘腾出 11.22GB。

## 7. 第三轮补充（自动打开 / 工作流图 / 调研 / 清理）

### 7.1 别人是怎么做 ComfyUI MCP 的

主要参考 [halbert04/comfyui-mcp](https://github.com/halbert04/comfyui-mcp)（GitHub，用带代理的浏览器打开），
另外 PyPI 上还有 comfyui-easy-mcp、iflow-mcp_orion4d-comfyui_mcp、imagehearth-mcp 等变体（页面被 CF 挡了，没细读）。

它的做法：
- **三层工具**：一键盘（text_to_image / upscale / inpaint / video…）→ Comfy API 节点（200+ 云端）→ 自定义工作流。
- 自定义工作流那一层是**增量搭图**：`search_nodes` / `get_node_schema` / `create_workflow(template)` /
  `add_node` / `suggest_next` / `validate_workflow` / `execute_workflow`。
- 提交前校验 COMBO 值、INT/FLOAT 范围、必填项；`queue_only=true` + `wait_for_jobs` 做异步并发。
- 配套 `upload_image` / `upload_mask` / `list_files` / `get_logs`。

我借鉴了三点并落地：`comfy_nodes`（搜节点 + 看 schema）、**数值范围校验**（steps/cfg 越界在提交前就报）、
以及「提交时记参数、完成时落记录」的 pending 机制。
没抄的：40+ 一键盘、云 API 节点、视频/3D——本机没有对应模型，堆工具只会让 agent 更容易误用。
本项目的差异点仍然保留：**看得见图**（联络表 + 客观指标 + 视觉评审）、精选清单、看板。

### 7.2 工作流图

`http://127.0.0.1:8790/flow`：
- 上半部分是 agent 的真实循环（写参数 → 静态校验 → 提交 → ≤55s 等待/接力 → 取图体检 → 联络表 → 我挑/你挑 → 迭代）；
- 下半部分是**从 workflow JSON 解析出来的真实节点图**（按依赖深度自动分层、SVG 画边），
  不是手画的示意图；旁边列出模板参数绑定到哪个节点。

### 7.3 看板自动打开

`ui/server.mjs` 启动后自动用默认浏览器打开 `http://127.0.0.1:8790`
（`DASHBOARD_OPEN=0` 可关闭）。以后我一开始干活，你屏幕上就有画面，不用自己敲地址。

### 7.4 清理

`flux1-dev-bnb-nf4-v2.safetensors`（11.22GB）已删除，D 盘剩余约 287GB。

### 7.5 又抓到两个 bug

1. **运行记录文件名碰撞**：`saveRun` 只用 prompt_id 前 8 位 + 毫秒时间戳，批量回填时同一毫秒内
   4 条记录互相覆盖，第 3 张图直接从看板里消失（掉进「未归档」）。修复：加随机后缀。
2. **跨调用完成的批次不落记录**：`comfy_batch` 提交后如果没在当次调用里跑完，完成时没人写 runs/。
   修复：提交时把「这批怎么来的」写进 `.memory/pending/<id>.json`，完成时由 `summarizeEntries` 取出补成正式记录。


## 8. 附录：bnb-nf4 实测证据

结论：**不能，至少在这台机器的 ComfyUI 0.30.2 上不能。** 三条独立证据：

1. 直接提交 `UNETLoader(flux1-dev-bnb-nf4-v2.safetensors)` + 1 步 512 的小图，KSampler 报
   `RuntimeError: mat1 and mat2 shapes cannot be multiplied (1024x64 and 1x98304)`。
2. 同一次执行的日志里：
   `unet unexpected: ['img_in.weight.absmax','img_in.weight.quant_map','img_in.weight.quant_state.bitsandbytes__nf4', ...]`
   —— **量化信息（absmax/quant_map/quant_state）全部被当成未知键丢弃**，剩下的是打包过的
   4bit 权重，直接进 `linear` 就是形状错。
3. `comfy/` 目录下搜 `bitsandbytes|Params4bit|quant_state` **零命中**；ComfyUI 的 Python 里
   也没装 bitsandbytes。0.30.2 的量化栈是 comfy-kitchen（fp8/nvfp4/mxfp8/int8），没有 nf4 路径。

有没有救？理论上要「装 bitsandbytes + 一个能把 Params4bit 接进 Flux 模型的自定义节点」，
而这台机器 github 不通（只有 hf-mirror 通），旧版兼容节点也早就不适配 0.30 的 patcher 重构。
更关键：**收益≈0**——同级别的 4bit 已经有 `flux1-dev-Q4_K_S.gguf`（6.5GB）在稳定出图，
比它小 4.7GB、还不用额外依赖。所以我的建议是删掉那个 11.2GB 文件；
真要「用上它」，唯一有意义的路是把它当素材做实验，而不是当生产力模型。

