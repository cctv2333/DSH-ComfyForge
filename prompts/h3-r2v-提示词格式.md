# H3 提示词格式（官方协议为准）

> **本文件 2026-11-06 重写。**
> 上一版是从我们手上的两份样本反推出来的，有三处与官方规范冲突（详见
> [`docs/H3-官方协议对齐报告-2026-11-06.md`](../docs/H3-官方协议对齐报告-2026-11-06.md)）。
> 现在以官方为准，样本降级为「实例」。
>
> **一手来源**（随官方仓库发布，不是社区猜测）：
> `MiniMax-AI/MiniMax-H3/skills/h3-prompt-writing/references/`
> · `base-en.txt` — T2VA / I2VA / FL2VA / L2VA
> · `ref-en.txt` — 全参考模式（Ref2VA）六段式
>
> 本文标注约定：**【官方】** = 一字不差来自上面两份；**【工程】** = 我们自己的经验，不是协议。

---

## 一、两种结构（字段名与顺序固定）

**三段式**（无参考图 / 首帧 / 首末帧 / 末帧）：

```
integrated_multimodal_description:
overall_soundscape:
non_diegetic_music:
```

**六段式**（全参考，我们用二采时就是这条）：

```
subject_definitions:
summary:
retention_analysis:
detailed_description:
overall_soundscape:
non_diegetic_music:
```

顺序不能换、不能加段、不能少段。**H3 没有负向栏**，不要写 `negative_prompt` / `negative`。

---

## 二、图片对齐指令行（只有首帧/首末帧/末帧模式才有）【官方】

必须是**第一行**，后面接**一个空行**，再进正文。句式固定：

- 首帧：`For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`
- 首末帧：`How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.`
- 末帧：`How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.`
- 纯文生：**没有**这一行。

---

## 三、分镜与切点【官方】

- `[Shot 1]` **不写时间码**
- 第二镜起：`[Shot N] At 00:03.500, ...`，**严格递增**、且落在时长内
- 普通切换：`the camera cuts to` / `the shot transitions to` / `the shot changes to`
- 只有明确要求才用 cross-dissolve / fade / wipe
- 切点必须带来新信息（主体、空间、状态、视角、时间）。**只是景别或轻微角度变化，优先用运镜**

---

## 四、运镜 = 类型 + 幅度 + 速度【官方】

类型：`Zoom In/Out`、`Push In/Pull Out`、`Pan L/R`、`Truck L/R`、`Tilt Up/Down`、`Pedestal Up/Down`、`Arc Shot`、`Tracking Shot`、`Static Shot`、`Shake Slightly/Strongly`、`POV`、`Roll Clockwise/Counterclockwise`
幅度：`with small amplitude` / `with large amplitude`（中等就省略）
速度：`at slow speed` / `at fast speed`（常速就省略）

写成自然动作句：

```
The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.
```

> 注意 `Tilt Down` 是机身不动、镜头下转；整机下降是 `Pedestal Down`。这两个常被写混。

---

## 五、对白、声源、跨切点【官方】

- 会发声的人给稳定 ID：`(S1)` `(S2)`；多人齐声 `(S1,S2)`；**不发声的人不给编号**；同一人跨镜同一 ID
- **ID、身份描述、动作、语气全写在 `<d>` 外面**；`<d>` 里只有语言标签 + 逐字原文：

```
The young woman with a quiet, breathy voice (S1) says: <d>[English] I get off at the next station.</d>
```

- 画外音：固定短语 `says in an off-screen voiceover`，**后面紧接**说明画内人物嘴闭合
- 跨切点同一句：两段连接处都加 `<scenetrans>` 并明确音频连续
- 被片尾截断：`<cutoff>`
- 画面可见文字：用**英文双引号**逐字保留 → `A red neon sign reading "营业中" glows above the doorway.`
- 听不清：写 `[unclear]`，**不要猜、不要改写**

---

## 六、两条声音字段的职责（最容易写错）【官方】

| 字段 | 写什么 | 不许写 | N/A 条件 |
|---|---|---|---|
| `overall_soundscape` | 1–4 句，**整段**环境声/物理动作声/非语言人声的**概括** | 对白、歌唱、有源音乐；**逐镜同步的具体音效**（那些必须留在正文对应镜头里） | 只有明确要求**全片完全静音** |
| `non_diegetic_music` | 1–3 句，乐器、速度、节奏、强弱变化 | **抽象情绪词**；解释配乐的情感作用；角色能听见的音乐（那是 diegetic，写进正文） | 没有非叙事配乐时写 `N/A` |

> **上一版我们把 `overall_soundscape` 写成了「逐镜音效清单」，这是与官方直接冲突的。**
> 正确写法是一段概括：
>
> ```
> overall_soundscape: Steady rain taps against the café windows while low room ambience continues underneath.
> ```
>
> 逐镜的「翻炒声在点火那一下」「刀落砧板」这类，写在对应 `[Shot N]` 的正文里。

---

## 七、参考标签与保留分析（六段式）【官方】

四类标签，**分配后含义跨六段保持一致**：

| 标签 | 指什么 |
|---|---|
| `<Subject N>` | 可复用的可见内容（人、动物、物件、场景、服装、风格、动作…） |
| `<Picture N>` | 作为**具体帧**或构图锚的参考图 |
| `<Video N>` | 整条视频的结构/编辑/延续源 |
| `<Audio N>` | 音频信号（复制或参考） |

**`<Picture N>` 只在它本身充当某镜首帧/关键帧/末帧/构图锚时才单列一条。**
只是用来定义角色/场景/服装/风格的，**不要把图单列**，把图源写进对应 `<Subject N>` 里：

```
<Subject 1> is the young woman in <Picture 1>, with long dark hair and a blue cardigan.
```

`retention_analysis` 每行一个标签 + **逗号列举**出现的镜号 + 固定标记：

```
<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - identity and outfit retained.
```

| 可见内容标记 | 音频标记 |
|---|---|
| `fully_preserved` | `fully_copy` |
| `partially_preserved` | `partially_copy` |
| `attribute_transfer` | `reference` |
| `weak_reference` | `weak_reference` |

`summary` 用方括号任务类型开头：`[reference generation]`、`[keyframe completion]`、`[video editing]`、`[video continuation]`、`[audio reuse]`、`[audio reference]`；多种关系用 ` + ` 连接。

---

## 八、篇幅【官方】

- `detailed_description`（生成任务）**通常 350–500 英文词**；对白密集时优先装下完整发话时间线，不机械凑字数
- 风格总述放在 `[Shot 1]` **之前**，一到两句英文
- 单镜不代表可以写短；按信息量分配

> 【工程】我们那份 15 秒 5 镜、11,270 字的样本，密度是官方指引的几倍。
> 它可能是好片子，但**它不是规范**。上一版把它写成「进阶版密度」并给了「给二采准备」的解释，
> 那个解释是我们编的。要照它写可以，但要清楚这是实验选择。

---

## 九、可直接填空的六段模板（官方结构）

```
subject_definitions:
<Subject 1> is {角色} in <Picture 1>: {体型；发型发色；瞳色；头饰；服装逐件}。本片新增 {变化}。
<Subject 2> is {环境} in <Picture 1>: {材质、光源方向、关键陈设}。
<Subject 3> is {道具}: {外形、状态、片中如何变化}。
{Audio 1 若用}: <Audio 1> is the voice-timbre reference for <Subject 1> (S1).

summary:
[reference generation] {N} 秒 {主题}。<Subject 1> 在 <Subject 2> 中按严格顺序：{动作1}，{动作2}，{收尾}。

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): partially_preserved - 保留身份与五官；围裙改为新增。
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - 陈设与光源方向不变。

detailed_description:
{风格总述，1–2 句，在 [Shot 1] 之前}
[Shot 1] {景别机位}，{主体与动作}。<Subject 1> (S1)，{声音描述}，说：<d>[English] {原话}</d>。{收尾动作}
[Shot 2] At 00:03.000, the camera cuts to {景别}。{动作与运镜}
[Shot N] At 00:0N.000, …

overall_soundscape:
{1–4 句整段概括：环境底噪 + 物理动作声 + 非语言人声}

non_diegetic_music:
{1–3 句：乐器、速度、节奏、强弱变化；没有就写 N/A}
```

---

## 十、发出去之前的自检

**机械检查已经做成工具**（`mcp/lib/h3protocol.mjs`）：

```bash
npm test                        # 69 项单测，含 H3 结构校验的正/负样本
```

`comfy_video` 在**提交前**会跑一遍，error 级直接拦下、不发起执行，并把问题清单按字段位置列出来。
确实要跳过（复刻旧稿/对照实验）传 `allow_invalid_prompt=true`。

**人会漏、工具会查的那几条**：

- [ ] 六个 / 三个段名与顺序对
- [ ] 首镜没写时间码；后续 `At MM:SS.mmm` 严格递增
- [ ] 每个 `<d>` 都闭合，且前面有 `(S n)` 或 `<Audio n>`
- [ ] 声源编号按**首次发声顺序** 1,2,3…
- [ ] 用到的 `<Subject n>` / `<Picture n>` / `<Audio n>` 都在 `subject_definitions` 里定义过
- [ ] `retention_analysis` 每行有合法标记（可见用 preserved 系，音频用 copy/reference 系）
- [ ] `overall_soundscape` **是概括，不是逐镜清单**
- [ ] `non_diegetic_music` 没写抽象情绪词；没配乐写 `N/A`
- [ ] 没有 `negative` / `negative_prompt`

**【工程】另外两条跟协议无关，但我们踩过**：

- 帧数必须落在 `5 + 17k`（24fps：15s→362，5s→124）—— 这是模型的时序步长
- 二采用 SplitSigmas 8+4，**不要**用独立的 `BasicScheduler(denoise=0.35)`：
  它会把 35% 噪声重新灌进整个 AV latent，音频退化成谐波嗡鸣（过零率 0.013 → 0.063 才正常）
