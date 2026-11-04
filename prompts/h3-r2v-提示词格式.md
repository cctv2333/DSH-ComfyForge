# H3 r2v 提示词格式（从两份一手样本反推）

来源（都在本机，可直接对照）：

1. `prompts/examples/黑鹤派-流萤做饭-15s-5镜.txt` — 11,270 字，15s / 5 镜，进阶版
2. `prompts/examples/官方模板-双人对战-5s.txt` — 1,091 字，5s，最小版（随 latent 放大节点附带的官方模板）

两份**同构**：先是主体/资产定义，中间是动作与镜头，末尾固定两段 `overall_soundscape:` 和 `non_diegetic_music:`。
差别只在进阶版多了 `summary`、`retention_analysis`、`[Shot N]` 分镜与时间码。

---

## 一、进阶版的六段骨架

```
subject_definitions:
<picture 1> 是什么（参考图本身）
<subject 1> 是角色（身份 + 外观清单 + 媒介声明 + 本片增删）
<subject 2> 是环境
<subject 3> 是道具/关键物件

summary:
[reference generation] 一句话说清时长、主体、环境、动作的严格顺序、物理约束

retention_analysis:
<subject n> (appears in [Shot 1] through [Shot N]): fully_preserved / partially_preserved - 为什么
<picture 1> (identity anchor for all shots): fully_preserved - 它锚定什么

detailed_description:
[全局风格/运镜/约束段]
[Shot 1] 景别机位 … Hand assignment … 必须做到什么程度 … 表情 … Sound sync …
[Shot 2] At 00:03.000, …
[Shot 3] At 00:05.500, …
…

overall_soundscape:
逐镜声音事件清单

non_diegetic_music:
BPM + 乐器 + 卡点 + 收尾
```

段标题一律 **小写 + 冒号**，单独占一行；`<Picture n>` / `<Subject n>` 是**先定义后引用**的占位符，正文里反复引用同一个符号，模型因此知道"这个符号指同一张图的同一个东西"。

## 二、每段到底在约束什么

| 段 | 实际作用 | 不写会怎样 |
|---|---|---|
| `subject_definitions` | 把图片变成一个可被文字引用的实体；角色条目里逐项写发色/瞳色/配饰/服装，是为了让二采精修时**有细节可重建** | 模型自由发挥，跨镜换人 |
| `summary` | 给全局的"动作顺序 + 物理规则" | 动作乱序、道具乱飞 |
| `retention_analysis` | 显式声明"哪些必须保住、哪些允许变" | 它会把你没写的东西当可改 |
| `detailed_description` 的全局段 | 定画面语言（写实 vs 赛璐璐）、剪辑节奏、总禁令 | 风格漂移 |
| `[Shot N]` 块 | 分镜：景别机位 + 手分工 + 完成度 + 表情 + 声音 | 一手多物、手崩、动作半途而废 |
| `overall_soundscape` | 逐镜音效清单，且要求"与动作同时" | 音画不同步、乱加音效 |
| `non_diegetic_music` | 音乐（BPM、乐器、卡点、终止） | 背景音发闷或与剪辑点无关 |

## 三、从样本里提炼出的硬规则（都有一手出处）

1. **媒介声明写进角色条目**：`3D-rendered-2D-anime ("cel-shaded") look: flat cel color bands, crisp outlines, very simple anime faces … no realistic human facial anatomy`。先把"不要写实脸"钉死，比在负面里写 ten times 更有效。
2. **手：每镜必写 `Hand assignment`**，且写"整镜不变"（`Hand assignment for the whole shot:`），左手做什么、右手做什么、什么时候松手。进阶版几乎每镜都重复"她有且只有两只手"（`exactly two hands`），并在违规处点名（`never render a third hand, extra fingers, or duplicated hands`）。
3. **绝对化 + 否定列举**：`EVERY piece`、`ALL the diced pieces`、`no half-cut slices, no whole chunks`、`not one piece is left on the board`。对"切完/倒完"这类**完成度**动作，只写"切开"会让模型演一半。
4. **物理约束要显式**：`every prop is released before the same hand takes the next one`、`no bowl, bottle, knife, board, or plate ever enters the wok`。
5. **时间码**：第 1 镜不写（默认 00:00），第 2 镜起 `At 00:03.000,`；末镜写 `hold … until 00:15.000`。切点不等距（本例 0 / 3.0 / 5.5 / 10.0 / 12.5，单镜 2.5–4.5s）。
6. **每个动作都配一条 `Sound sync`**，并强调同步关系：`exactly when the blue flame blooms`、`the instant the vegetables touch the oil`、`never play before or after their matching visual`。
7. **表情单独交代**，且与镜头情绪对齐；末镜常写"眼睛睁开"（`eyes OPEN`）——因为模型爱在结尾闭眼/眯眼。
8. **长度密度**：15s / 5 镜用 11,270 字，约 2,200 字/镜。官方最小版 5s 用 1,091 字，约 220 字/s。**进阶版的密度是给二采准备的**——一采在 608×352 上看不出细节，二采要靠这些词把纹理重建出来。

## 四、可直接填空的模板

```
subject_definitions:
<Picture 1> is the reference image: {这张图是什么——三视图/正脸/场景照}.
<Subject 1> is {角色名/身份} in <Picture 1>: {体型与比例；发型与发色；瞳色；头饰；服装逐件}。本片在保留 <Picture 1> 全部标志元素的前提下，新增 {本片变化，如围裙}。媒介与风格：{cel-shaded / 写实 / 定格} —— {具体到"平涂色块/锐利描边/面部极简"}，不要写实人脸解剖。
<Subject 2> is {环境}：{材质、光源方向、关键陈设}.
<Subject 3> is {道具/关键物件}：{外形、状态、片中如何变化}.

summary:
[reference generation] {N} 秒 {单/多}人 {主题} 展示，<Subject 1> 使用 <Picture 1> 中的确切外观，在 <Subject 2> 中工作。严格按顺序：{动作1}，{动作2}，{动作3}，{动作4}，最后 {收尾动作}。{物理约束：只有两只手；每个道具先放下再换手；A 永不进入 B}。

retention_analysis:
<Subject 1> (appears in [Shot 1] through [Shot N]): partially_preserved - {保留什么；只改什么}.
<Picture 1> (identity anchor for all shots): fully_preserved - {它锚定比例/五官/发型/服装}.
<Subject 2> (appears in [Shot 1] through [Shot N]): fully_preserved - {环境一致性要求}.
<Subject 3> (appears in [Shot 1] through [Shot N]): fully_preserved - {物件如何贯穿}.

detailed_description:
{全局段：风格对撞（写实环境 + 二维角色）、剪辑节奏（beat-cut / 长镜）、总体禁令（手、道具、表情）}
[Shot 1] {景别 + 机位} of <Subject 2>。Hand assignment for the whole shot: 左手 {只做什么}；右手 {只做什么}。{必须完成到什么程度——用 EVERY / ALL}。{表情}。Sound sync: {每条音效对应哪个动作}。
[Shot 2] At 00:0{3}.000, {景别机位}。Hand assignment: 右手 {…}；左手 {…}。{动作与完成度}。{表情}。{运镜}。Sound sync: {…}。
[Shot 3] At 00:0{5}.500, …
[Shot 4] At 00:1{0}.000, …
[Shot 5] At 00:1{2}.500, {收尾镜}。{双手如何收}。{表情：eyes OPEN}。{点缀效果}。Sound sync: {…}；hold until 00:0{N}.000。

overall_soundscape:
{环境底噪一句话}。所有音效严格与动作同步、绝不早于或晚于对应画面：Shot 1 —— {…}；Shot 2 —— {…}；…；Shot N —— {…}。

non_diegetic_music:
{BPM 与风格}：{主奏乐器} 带 {旋律特征}，{打击乐}，{低音}；{卡点位置：切镜/翻炒/点火}；{收尾：明亮解决和弦 / 骤然切断}。
```

## 五、发出去之前自检（以后应做成工具的静态检查）

- [ ] 六个段标题齐全，`overall_soundscape` / `non_diegetic_music` 在最后
- [ ] 每个 `<Subject n>` 都在 `subject_definitions` 里定义过；每个 `<Picture n>` 都有对应输入图
- [ ] 角色条目里有**媒介声明**（写实 / 赛璐璐）与**本片增删**
- [ ] 每个 `[Shot n]` 都有 `Hand assignment`、完成度措辞、表情、`Sound sync`
- [ ] 时间码单调递增，末镜 `until` = 目标时长
- [ ] 目标时长换算帧数落在 `5 + 17k`（24fps：15s→362，5s→124）
- [ ] 至少 3 处绝对化措辞 + 3 处否定列举（`no …` / `never …`）
- [ ] `non_diegetic_music` 写了 BPM（否则音乐容易发闷）
