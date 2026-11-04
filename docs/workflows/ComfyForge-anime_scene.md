# 工作流：ComfyForge-anime_scene

- 格式：UI（前端保存）
- 节点数：10（去重 9 类）
- 模型文件：flux1-dev-Q4_K_S.gguf、clip_l.safetensors、t5xxl_fp16.safetensors、flux-ae.safetensors

## 节点清单

| 节点 | 次数 | 本机状态 |
|---|---|---|
| CLIPTextEncode | 2 | 未知（ComfyUI 没连上） |
| UnetLoaderGGUF | 1 | 未知（ComfyUI 没连上） |
| DualCLIPLoader | 1 | 未知（ComfyUI 没连上） |
| VAELoader | 1 | 未知（ComfyUI 没连上） |
| FluxGuidance | 1 | 未知（ComfyUI 没连上） |
| EmptySD3LatentImage | 1 | 未知（ComfyUI 没连上） |
| KSampler | 1 | 未知（ComfyUI 没连上） |
| VAEDecode | 1 | 未知（ComfyUI 没连上） |
| SaveImage | 1 | 未知（ComfyUI 没连上） |

## 依赖结论

本机节点齐全，可以直接跑（模型文件是否齐另见能力清单）。

## 本机已装插件（可能相关）

- ComfyUI-GGUF — https://github.com/city96/ComfyUI-GGUF
- ComfyUI-Impact-Pack — https://github.com/facebookresearch/sam2
- ComfyUI-LTXVideo — https://github.com/Lightricks/LTX-2
- ComfyUI-Manager — https://github.com/ltdrdata/ComfyUI-Manager
- ComfyUI-RMBG — https://github.com/1038lab/ComfyUI-RMBG
- ComfyUI-VideoHelperSuite — https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite
- ComfyUI-WanVideoWrapper — https://github.com/kijai/ComfyUI-WanVideoWrapper
- comfyui_controlnet_aux — https://github.com/Fannovel16/comfyui_controlnet_aux
- ComfyUI_Custom_Nodes_AlekPet — https://github.com/AlekPet/ComfyUI_Custom_Nodes_AlekPet
- ComfyUI_IPAdapter_plus — https://github.com/cubiq/ComfyUI_IPAdapter_plus
- ComfyUI_UltimateSDUpscale — https://github.com/ssitu/ComfyUI_UltimateSDUpscale