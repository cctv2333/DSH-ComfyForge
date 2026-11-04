# ComfyUI Agent 接入实测报告（ComfyForge 项目 · 第 1 轮）

- **日期**：2026-11-03
- **对象**：<DEV>\ComfyUI-aki-v3.2（秋叶整合包 v3.2，ComfyUI 0.30.2，py 3.13.11，torch 2.13.0+cu130）
- **硬件**：RTX 5060 Ti 8GB / 内存 16GB 单通道（可用 14.9GB）/ D 盘
- **执行者**：Chatbox agent（本文所有结论均有实测依据，非推测）

---

## 1. 结论摘要

1. **Agent 可以直接接入 ComfyUI，无需任何插件。** ComfyUI 自带 HTTP API（127.0.0.1:8188）就是为程序化调用设计的；《AI_Game_Studio 技术论文》3.2 节的协议判断正确。
2. **已将其 MCP 化**：本项目实现 `ComfyForge`（server id `comfy-forge`），零依赖 Node stdio MCP 服务器，6 个工具，全链路自测通过（提交→等待→取图 base64 往返验证）。
3. **关键限制发现**：ComfyUI 0.30.2 **不再支持 legacy bitsandbytes nf4 量化模型**（已装的 flux1-dev-bnb-nf4-v2.safetensors 11.2GB 跑不了）；正路是 **GGUF**（ComfyUI-GGUF 节点已内置）。
4. 首张端到端产物：768×768×20 步 FLUX GGUF Q4_K_S，约 50 秒/张（含 t5 编码；模型热身后更快）。

---

## 2. 环境与资产（实测清单）

| 项 | 值 |
|---|---|
| ComfyUI | 0.30.2，常驻运行，`--auto-launch --preview-method auto --cuda-malloc` |
| API 地址 | http://127.0.0.1:8188 |
| unet | `flux1-dev-Q4_K_S.gguf`（6.8G，hf-mirror 下载，aria2 16 连接约 3 分钟）；`flux1-dev-bnb-nf4-v2.safetensors`（11.2G，**不可用**，见 §4） |
| 文本编码器 | `clip_l.safetensors`（246MB，本次补装）+ `t5xxl_fp16.safetensors`（9.3G，超显存→CLIP 自动落 CPU） |
| VAE | `flux-ae.safetensors` |
| custom_nodes | Impact-Pack / IPAdapter_plus / GGUF / WanVideoWrapper / LTXVideo / RMBG / controlnet_aux / UltimateSDUpscale / Manager 等 11 个 |
| 日志 | `ComfyUI\user\comfyui.log` |

---

## 3. 接入协议（实测）

```
POST /prompt            body = {"prompt": <API格式工作流图>}     → {prompt_id, number}
GET  /history/{id}      → status.status_str ∈ {success, error} + outputs（产物文件名）
GET  /queue             → 队列状态
GET  /system_stats      → 版本/GPU/显存
GET  /object_info/<节点> → 节点参数与可选模型列表
GET  /view?filename=&subfolder=&type=  → 取图二进制
```

工作流图为 API 格式：`{ "节点id": {"class_type": ..., "inputs": {..., "引用": ["节点id", 输出口]}} }`。
WebUI 中 **Save (API Format)** 导出即此格式（论文 3.2.3 同款）。

---

## 4. 坑清单（全部实测，可直接复用）

1. **外层包裹**：`/prompt` 的 body 必须是 `{"prompt": 图}`；裸图返回 `{"error":{"type":"no_prompt"}}`。
2. **UTF-8 BOM**：PowerShell 5.1 `Set-Content -Encoding utf8` 写出的文件带 BOM（EF BB BF），aiohttp `json.loads` 遇 BOM 直接 **500 且无错误体**（极难诊断）。写 JSON 必须用 `[System.IO.File]::WriteAllText(...)`（无 BOM）。
3. **PowerShell 传 JSON 给 curl**：用 `--data-binary @文件`；用 `-d $变量` 会二次序列化导致 500。
4. **legacy bnb nf4 不支持**：0.30.2 的量化栈是 comfy-kitchen（fp8/nvfp4/mxfp8/int8/convrot），仓库内无 bitsandbytes 代码路径。症状：加载日志 `unet unexpected: [...quant_state.bitsandbytes__nf4...]`，KSampler 报 `mat1 and mat2 shapes cannot be multiplied (2304x64 and 1x98304)`（packed Params4bit 直进 matmul 的特征）。**装 bitsandbytes 包无效**。正路 = `UnetLoaderGGUF` + GGUF 模型。
5. **FLUX 双编码器**：DualCLIPLoader 需要 clip_l + t5 两个文件，整合包只带 t5；缺 clip_l 时选项列表会只剩 t5（易误配）。
6. **t5xxl fp16 (9.3G) > 8G 显存**：ComfyUI 自动把 CLIP 放 CPU 跑，能跑但编码偏慢；追求速度可换 t5xxl_fp8（约 4.9G）。
7. **网络**：host 的 curl 到 github/raw.githubusercontent 不通（Steam++ 只代理浏览器进程）；**hf-mirror.com 全通**，模型下载走它。整合包自带 `aria2c.exe`（.launcher 目录）可 16 连接加速。
8. **SaveImage 序号**：产物名 = `前缀_0000N_.png`，N 按前缀递增，与 seed 无关。

---

## 5. 性能数据（实测）

| 任务 | 耗时 |
|---|---|
| 768×768×20 步 FLUX GGUF Q4_K_S（模型已热身） | ≈50s |
| 512×512×8 步 | ≈20-30s |
| GGUF 6.8GB 下载（hf-mirror + aria2 x16） | ≈3min |
| clip_l 246MB 下载（hf-mirror 单连接） | 78s（≈3MB/s） |

---

## 6. ComfyForge MCP（B 档接入，已实现并自测）

- **位置**：`<REPO>\mcp\server.mjs`（零依赖，Node ≥18，stdio JSON-RPC）
- **命名**：ComfyForge / server id `comfy-forge`（ComfyUI 为炉，agent 为匠）
- **工具**：

| 工具 | 作用 |
|---|---|
| comfy_status | 版本/GPU/显存/队列体检 |
| comfy_list_models | 列出各 loader 可见模型 |
| comfy_flux_t2i | 内置 FLUX GGUF 模板文生图，返回 prompt_id |
| comfy_queue_workflow | 提交任意 API 格式工作流 |
| comfy_wait_result | 轮询 history 至完成/超时，返回产物清单 |
| comfy_get_image | /view 取图，base64 image content 返回 |

- **自测记录**：initialize / tools/list / comfy_status / comfy_flux_t2i（真实出图）/ comfy_wait_result / comfy_get_image（base64 往返 381,616 字节 PNG，内容=提示词"黄铜机器人浇盆景"）全部通过。
- **挂载方式（需用户在 Chatbox 设置 UI 手动添加，config.json 会被运行中的 Chatbox 覆盖）**：
  - 类型 stdio；命令 `<DEV>\nodejs\node.exe`；参数 `<REPO>\mcp\server.mjs`
  - 可选环境变量 `COMFY_URL` 覆盖默认 `http://127.0.0.1:8188`

---

## 7. 路线图（星火燎原）

- ✅ 第 1 步 根据地：A 档控制环路（HTTP 直连出图）——已完成
- ✅ 第 2 步：B 档 MCP 化（ComfyForge v0.1.0）——已完成，待用户挂载
- ⬜ 第 3 步：工作流模板库（论文 3.2.3：角色立绘/背景/图标 API 模板 + `_meta.title` 语义寻址 + 元数据落盘）
- ⬜ 第 4 步：质检（论文 3.4：WD14 全量过滤 → VLM 复检）与资产库 manifest
- ⬜ 待定：废弃的 bnb nf4 11.2GB 文件是否删除（等用户指令）

---

## 附录：最小复现命令

```powershell
# 提交（文件须无 BOM）
curl.exe -s -X POST -H 'Content-Type: application/json' --data-binary @wf.json http://127.0.0.1:8188/prompt
# 轮询
curl.exe -s http://127.0.0.1:8188/history/<prompt_id>
# MCP 自测
Get-Content selftest.jsonl | <DEV>\nodejs\node.exe <REPO>\mcp\server.mjs
```
