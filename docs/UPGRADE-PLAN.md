# ComfyUI 升级预案（0.30.2 → 0.44.0）

> 结论先说：**这次升级值得做，但不能直接点"更新"**。
> 本地仓库和上游历史是**分叉**的（不是简单的落后），启动器如果做 `git pull` 会产生合并，
> 578 个提交的合并大概率失败或留下半截状态。正确做法是：先做快照 → 用 `reset --hard` 对齐上游 → 再修自定义节点。

- 采集时间：2026-11-04
- 环境：Windows + ComfyUI 便携整合包（绘世 aki 版）。下文记作 `<COMFY_ROOT>`（含 `main.py`、`python/`、`git/` 的那一层）
- 当前版本：**0.30.2**，HEAD `dec5d9450`
- 上游目标：**0.44.0**（`origin/master` = `56f179f6c`）
- 落后 **578** 个提交；本地另有 7 个提交，其中 5 个上游已有（`git cherry` 判定 `-`），
  只有 `v0.30.1` / `v0.30.2` 两个发版提交是"本地独有"——即 **没有独占代码会丢**。
- 工作区干净（`git status` 无输出）；磁盘剩余 **249 GB**，足够备份。
- 分支：`master`，远端 `https://github.com/Comfy-Org/ComfyUI`

> 下面的命令块里，`<COMFY_ROOT>` 指整合包根目录，`<REPO>` 指本仓库根目录。
> 请替换成你自己的路径——**这些值在你的机器上一定不同**。

---

## 一、升级能得到什么（有证据，不是许愿）

直接在 0.44.0 的源码里查到的：

### 1. H3 的原生二采节点（这是上次失败的解药）

`comfy_extras/nodes_minimax_h3.py` 里新增：

```python
class MiniMaxH3LatentUpscaleWithModel(io.ComfyNode):
    node_id="MiniMaxH3LatentUpscaleWithModel"
    description="Resizes the video of a MiniMax H3 latent with a latent upscale model; audio passes through unchanged."
    ...
    latents = samples["samples"]
    video = latents.tensors[0] if latents.is_nested else latents
    ...
    out["samples"] = comfy.nested_tensor.NestedTensor((upscaled, latents.tensors[1])) if latents.is_nested else upscaled
```

**它显式处理 `is_nested`，并且"音频原样透传"。** 之前用第三方 `MinimaxH3LatentUpscaler3D` 报
`'NestedTensor' object has no attribute 'dim'`，根因就在这里——0.44 的核心节点把它解决了。

### 2. H3 的控制类节点

同文件新增：`MiniMaxH3AddGuide`、`PH3ImageConditioning`、`MiniMaxH3FunControlNetApply`。
分别对应"引导帧"、"图像条件"、"ControlNet 接入"。

### 3. H3 节点签名会变（这是**破坏性**的）

`nodes_minimax_h3.py` 差异：+447 / −35 行，其中：

```diff
- io.Vae.Input("audio_vae"),
+ io.Vae.Input("audio_vae", optional=True, tooltip="Audio VAE. Without it reference audio only conditions the text encoder.")
- def execute(cls, clip, vae, audio_vae, prompt, width, height, length, ...)
+ def execute(cls, clip, prompt, width, height, length, ref_image_size="match", vae=None, audio_vae=None, ...)
```

含义：**你写死的 API 工作流（节点 id 与输入名）升级后要重跑一遍验证。**
尤其是 `MiniMaxH3ReferenceToVideo`：`audio_vae` 从必填变成可选，参数顺序也变了。

### 4. 依赖变化

```diff
-comfyui-frontend-package==1.47.12   +comfyui-frontend-package==1.58.5
-comfyui-workflow-templates==0.11.31 +comfyui-workflow-templates==0.11.101
-comfyui-embedded-docs==0.5.9        +comfyui-embedded-docs==0.5.16
-torchaudio                          (被移除)
-av>=16.0.0                          +av>=17.0.0
-comfy-kitchen==0.2.26               +comfy-kitchen==0.2.40
-comfy-aimdo==0.4.11                 +comfy-aimdo==0.6.0
```

`av` 会从 16 升到 17（VideoHelperSuite 依赖），`comfy-kitchen` / `comfy-aimdo` 是带 CUDA 内核的包，**会重装二进制**。
`torchaudio` 被移除——如果你的某个节点 import 它，升级后会炸。

---

## 二、升级**会**破坏什么（提前修，别等报错）

| # | 风险 | 具体后果 | 处理 |
|---|---|---|---|
| 1 | **自定义节点与核心同名** | 有的兼容节点也叫 `ModelAttentionBackend`，而 0.44 核心已有同名节点 → 重复注册，可能启动报错或行为不确定 | **升级前把冲突的自定义节点整目录改名或移走** |
| 2 | **本地历史分叉** | 启动器 `git pull` → 578 提交合并 → 冲突/半截状态 | 用 `git fetch` + `git reset --hard origin/master`，不要 pull |
| 3 | **部分包没有 git** | 有些包是解压装的，**无法 `git pull` 更新**，也没版本号 | 升级前记下版本（快照里有）；不兼容时只能重下最新版覆盖 |
| 4 | **第三方包的 requirements 被改过** | 精简过依赖，避免启动器自动装重包时卡住；重装该包会恢复原样 | 重装后**再精简一次** |
| 5 | **pip 会被带着升** | `av 16→17`、`comfy-kitchen`、`comfy-aimdo`、frontend | 升级前 `pip freeze` 快照；升完对比差异 |
| 6 | **第三方文件的小补丁会被覆盖** | 改过的核心文件，重装/更新即还原 | 重装后重新打（或改用环境变量规避） |
| 7 | **工作流可能打不开** | 0.44 前端 1.58 的工作流格式可能有新字段 | `user/default/workflows` 先备份 |

---

## 三、升级前 checklist（照做，10 分钟）

```bat
:: 0) 关掉 ComfyUI（用启动器关，别杀进程）

:: 1) 打快照（版本/git/包清单/pip/工作流 全留档）
node <REPO>\tools\pre-upgrade-snapshot.mjs --root <COMFY_ROOT>

:: 2) 备份整个 custom_nodes（约 1-2 GB，最保险）
robocopy "<COMFY_ROOT>\ComfyUI\custom_nodes" "<REPO>\backups\custom_nodes" /E /NFL /NDL

:: 3) 移走会冲突的兼容节点（按你的实际情况改目录名）
move "<COMFY_ROOT>\ComfyUI\custom_nodes\<冲突包名>" "<REPO>\backups\disabled_nodes"

:: 4) 记录当前 HEAD（回退用）
"<COMFY_ROOT>\git\cmd\git.exe" -C "<COMFY_ROOT>\ComfyUI" rev-parse HEAD
```

> 第 3 步别省。这是本次升级**唯一确定会冲突**的地方。

---

## 四、升级怎么做（推荐顺序）

**推荐：先在 git 里对齐上游，再用启动器"修复/更新环境"补依赖。**

```bat
set G=<COMFY_ROOT>\git\cmd\git.exe
set C=<COMFY_ROOT>\ComfyUI

%G% -C %C% fetch origin
%G% -C %C% reset --hard origin/master      :: 丢弃分叉的本地提交（内容上游都有）
%G% -C %C% log -1 --oneline                 :: 应显示 0.44.0 对应提交
```

然后补依赖：

```bat
<COMFY_ROOT>\python\python.exe -m pip install -r <COMFY_ROOT>\ComfyUI\requirements.txt
```

> 如果让启动器去更新：它多半会走 `git pull`，遇到分叉要么报错、要么生成一个巨大的合并提交。
> **如果非要走启动器，先做第 2、3 步备份，并在它卡住时知道回退命令。**

---

## 五、升级后验证（按顺序，前一步不过就别往下走）

| # | 检查 | 命令 / 方法 | 期望 |
|---|---|---|---|
| 1 | 版本 | `comfyui_version.py` | `0.44.0` |
| 2 | 启动无报错 | 控制台 + `user/comfyui.log` 的 Import times 块 | 无 `IMPORT FAILED` |
| 3 | 节点总数 | `/object_info` | 应显著多于升级前的数量（新节点进来） |
| 4 | H3 新节点 | 查 `MiniMaxH3LatentUpscaleWithModel` | 存在 ✅ |
| 5 | 你的工作流 | `node tools/check-workflow.mjs "<工作流路径>"` | 0 缺失（`ModelAttentionBackend` 由核心提供） |
| 6 | API 工作流 | 用最小参数跑一次 3 秒出片 | 出片 |
| 7 | 二采 | 用新的核心放大节点试 1 次 | **这是本次升级的核心目标** |
| 8 | MCP 工具 | `comfy_health` / `comfy_models` | 正常 |
| 9 | 显存 | `nvidia-smi` 观察峰值 | 不比现在更差 |

---

## 六、回退方案（升级失败就用这套）

```bat
set G=<COMFY_ROOT>\git\cmd\git.exe
set C=<COMFY_ROOT>\ComfyUI

:: 1) 回到旧提交（用第 4 步记下的 HEAD）
%G% -C %C% reset --hard <升级前 HEAD>

:: 2) 还原 Python 环境（用升级前的快照）
<COMFY_ROOT>\python\python.exe -m pip install -r <REPO>\backups\upgrade-<时间>\pip-freeze.txt

:: 3) 还原 custom_nodes（如果被改动过）
robocopy "<REPO>\backups\custom_nodes" "<COMFY_ROOT>\ComfyUI\custom_nodes" /E /MIR /NFL /NDL

:: 4) 把冲突节点放回去（旧版本才需要它）
move "<REPO>\backups\disabled_nodes" "<COMFY_ROOT>\ComfyUI\custom_nodes\<冲突包名>"
```

⚠️ `pip install -r pip-freeze.txt` 是"按当前源重装所有包"，不是快照回滚；真正稳妥的是**提前把 `python` 目录整个复制一份**（约 8-10 GB）。

---

## 七、风险结论

| 项目 | 评级 | 说明 |
|---|---|---|
| 升级收益 | ★★★★★ | 拿到 H3 原生二采 + 控制节点，直接解决"二采碎片"与"镜头控制"两个老问题 |
| 升级风险 | ★★★☆☆ | 578 提交 + 多个非 git 包 + 历史分叉 |
| 可回退性 | ★★★★☆ | git 有明确锚点；pip 环境建议整目录备份 |
| 建议 | **做，但按上面的顺序**：备份 → 移走冲突节点 → reset 对齐 → 补依赖 → 逐项验证 |

---

*证据来源：`git diff HEAD origin/master`、`git show origin/master:<file>`、`tools/pre-upgrade-snapshot.mjs` 快照*
