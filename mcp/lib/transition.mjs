// lib/transition.mjs —— 「中间态」提示词编译器
//
// 要解决的问题（用户 2026-11-13 的原话）：
//   「图片不能很好地理解一个人变成另外一个东西…… 就会有个东西叫做中间状态，
//     在图片上就感觉是好像是一个东西变成了另外一个东西的这种中间状态。」
//
// 为什么模型画不出来：
//   扩散模型没有时间轴。它画的是**一帧**。「变成」是个过程动词，没有对应的像素。
//   你写「A 正在变成 B」，它只能二选一：画成 B、或者把 A 和 B 画成两个东西并排/叠在
//   一起。这就是为什么"中间态"经常出不来。
//
// 唯一的出路是**把时间换成空间**：
//   同一具身体上，一部分已经是 B、一部分还是 A，交界处留下正在推进的物理痕迹。
//   观众看见"两种状态共存 + 交界在推进"，自己就补出了"正在变"。
//
// 两条原则（写在这里，因为整个文件都是它们的实现）：
//   1. **动词负责意图，名词负责像素。**
//      开头那句"这一帧是中间状态"不是没用——它告诉编码器要画变化；但只有它一个
//      字都不够，真正决定画面的是分区归属和交界材质。所以下面既有框架句，也有
//      一条一条的分区描述，二者缺一不可。
//   2. **交界决定成败。**
//      只写"一半已变一半未变"，出来是一条 Photoshop 蒙版式的直缝。必须写清楚
//      交界**靠什么机制**推进（顶裂 / 剥落 / 融化 / 生长 / 溶解 / 缝合 / 发光 / 黏液 /
//      灼烧 / 结晶），并把过渡带本身的材质写出来——"半塑料半毛"的那个中间材质，
//      才是这张图真正要画的东西。
//
// 用法：
//   import { buildTransition, describeOptions, EXAMPLES } from './transition.mjs';
//   const r = buildTransition({ from: '白色塑料无线鼠标', to: '灰毛家鼠', ... });
//   r.prompt   // 可直接喂给 MOSS / FLUX.2 / Krea2
//
// 也可以走 CLI：node tools/transition.mjs --example mouse

/** 主体怎么被切开。kind 决定句式：split=两段硬分界，gradient=连续渐变，radial=从中心向外。 */
export const AXES = {
  'near->far': {
    kind: 'split',
    zh: { changed: '靠观众这一侧', intact: '远端这一侧', landmark: '分界线垂直于视线，横过主体中段' },
    en: { changed: 'the side facing the viewer', intact: 'the far side', landmark: 'the boundary runs straight across the middle of the subject' },
  },
  'far->near': {
    kind: 'split',
    zh: { changed: '远端这一侧', intact: '靠观众这一侧', landmark: '分界线垂直于视线，横过主体中段' },
    en: { changed: 'the far side', intact: 'the side facing the viewer', landmark: 'the boundary runs straight across the middle of the subject' },
  },
  'left->right': {
    kind: 'split',
    zh: { changed: '左侧', intact: '右侧', landmark: '分界线竖直，落在主体中线附近' },
    en: { changed: 'the left half', intact: 'the right half', landmark: 'the boundary is vertical, near the centre line' },
  },
  'right->left': {
    kind: 'split',
    zh: { changed: '右侧', intact: '左侧', landmark: '分界线竖直，落在主体中线附近' },
    en: { changed: 'the right half', intact: 'the left half', landmark: 'the boundary is vertical, near the centre line' },
  },
  'bottom->top': {
    kind: 'split',
    zh: { changed: '下半段', intact: '上半段', landmark: '分界线是水平的，落在腰线高度' },
    en: { changed: 'the lower half', intact: 'the upper half', landmark: 'the boundary is horizontal, at waist height' },
  },
  'top->bottom': {
    kind: 'split',
    zh: { changed: '上半段', intact: '下半段', landmark: '分界线是水平的，落在腰线高度' },
    en: { changed: 'the upper half', intact: 'the lower half', landmark: 'the boundary is horizontal, at waist height' },
  },
  'root->tip': {
    kind: 'gradient',
    zh: { changed: '根部', intact: '梢部', landmark: '没有硬边界，是从根到梢的连续渐变', outward: '往根部这一段' },
    en: { changed: 'near the roots', intact: 'at the tips', landmark: 'no hard line, a continuous gradient from root to tip', outward: 'the stretch toward the roots' },
  },
  'tip->root': {
    kind: 'gradient',
    zh: { changed: '梢部', intact: '根部', landmark: '没有硬边界，是从梢到根的连续渐变', outward: '往梢部这一段' },
    en: { changed: 'at the tips', intact: 'near the roots', landmark: 'no hard line, a continuous gradient from tip to root', outward: 'the stretch toward the tips' },
  },
  'center->out': {
    kind: 'radial',
    zh: { changed: '躯干与中心', intact: '四肢与外缘', landmark: '没有硬边界，变化从中心向外递减' },
    en: { changed: 'the torso and centre', intact: 'the limbs and outer edges', landmark: 'no hard line, the change fades outward from the centre' },
  },
  'out->center': {
    kind: 'radial',
    zh: { changed: '四肢与外缘', intact: '躯干与中心', landmark: '没有硬边界，变化从外缘向中心收拢' },
    en: { changed: 'the limbs and outer edges', intact: 'the torso and centre', landmark: 'no hard line, the change closes inward from the edges' },
  },
};

/**
 * 交界机制。这是整个编译器的核心：选错机制，交界就是一条假缝。
 * `fits` 只是给建议，不强制——材质判断交给调用者。
 */
export const BOUNDARIES = {
  crack: {
    zh: '{fromFeature}被从内部顶出细密裂纹，{toFeature}从裂缝里一股股挤出来，裂缝边缘向外翘起、断口发白，缝里能看见湿润的新层',
    en: '{fromFeature} is split from underneath by a web of fine cracks; {toFeature} pushes out through them in tufts, the broken edges curling outward and showing pale, and the fresh layer underneath still wet',
    fits: '塑料/蛋壳/硬壳 → 生物（毛、鳞、触须）',
  },
  bloom: {
    zh: '{toFeature}顺着{fromFeature}的表面一片片长出来，靠边界的短而稀疏，越往外越密越长，根部长在表层之下',
    en: '{toFeature} sprouts across the surface of {fromFeature} in patches: short and sparse near the boundary, denser and longer further out, rooted below the surface',
    fits: '任何表面 → 毛发/羽毛/鳞片/花',
  },
  shed: {
    zh: '{fromFeature}一块块剥落、向外翻卷，露出的内层已经是{to}，剥落口还挂着没断干净的碎片',
    en: '{fromFeature} flakes away in curling pieces; the layer revealed underneath is already {to}, with torn fragments still hanging at the edges',
    fits: '外壳/装甲/厚皮/涂料 → 内层新形态',
  },
  melt: {
    zh: '{fromFeature}在交界处软化、下垂、拉成细丝，滴落的地方重新凝成{to}的形状，表面还在缓慢流动',
    en: '{fromFeature} softens at the seam, sagging and pulling into threads; where it drips it re-sets into the shape of {to}, the surface still slowly flowing',
    fits: '蜡/塑料/金属/糖/冰 → 另一形态',
  },
  dissolve: {
    zh: '交界没有清晰的边，{fromFeature}在这里碎成细颗粒散开，颗粒重新聚成{to}，过渡带是一层半透明的雾',
    en: 'the boundary has no clean edge: {fromFeature} breaks into fine grains and scatters, the grains re-forming into {to}, with a translucent haze across the transition',
    fits: '沙/雾/像素/魔法/尘 → 任何',
  },
  stitch: {
    zh: '两种材质被一条粗糙的缝合线连在一起，线脚两侧的组织互相长进对方，{toFeature}从缝口挤出来',
    en: 'the two materials are joined by a coarse seam, tissue growing across the stitches into each other, {toFeature} squeezing out of the seam',
    fits: '人造怪物/嫁接/弗兰肯斯坦式',
  },
  glow: {
    zh: '发光纹路从皮肤底下透出来，沿血管的走向往{to}那侧爬，纹路扫过的地方质地已经变了，边缘还有余烬似的暗光',
    en: 'luminous lines surface from under the skin and creep toward the {to} side along the veins; where they pass, the texture has already changed, with ember-like afterglow at the edge',
    fits: '魔法/恶魔化/诅咒/能量（皮肤类）',
  },
  wet: {
    zh: '交界被一层半透明的黏液膜包住，{toFeature}从膜下鼓起来往外长，膜里能看见还没成形的东西在动',
    en: 'the seam is sealed under a translucent film of slime; {toFeature} swells and grows out from beneath it, half-formed shapes moving inside the film',
    fits: '生物变异/异形/触手/寄生',
  },
  burn: {
    zh: '交界处一圈焦黑碳化，{toFeature}从焦痕中央破开长出来，黑色碎屑还粘在边沿',
    en: 'a ring of charred black surrounds the seam; {toFeature} breaks out from the centre of the burn, black flakes still clinging to the rim',
    fits: '火/高温/恶魔/灼伤',
  },
  crystal: {
    zh: '{toFeature}以晶簇的形式从{fromFeature}表面长出，靠边界的是细小晶粒，越往外晶体越大越完整',
    en: '{toFeature} grows out of the surface of {fromFeature} as crystal clusters: fine grains at the boundary, larger and more complete crystals further out',
    fits: '石/冰/水/矿物/结晶化',
  },
};

/**
 * 每种交界机制「非给不可」的材质特征。
 * 不给会退回到整段 from/to，读出来就是「银发少女顺着短发男性的表面长出来」这种别扭句子
 * —— 语法没错，但把一个人当成一种材质，编码器也跟着糊涂。所以缺了就提示。
 */
const NEEDS = {
  crack: ['fromFeature', 'toFeature'],
  bloom: ['toFeature', 'fromFeature'],
  shed: ['fromFeature'],
  melt: ['fromFeature'],
  dissolve: ['fromFeature'],
  stitch: ['toFeature'],
  glow: [],
  wet: ['toFeature'],
  burn: ['toFeature'],
  crystal: ['fromFeature', 'toFeature'],
};

/** progress → 说人话的占比。模型不会算百分比，只会看"三分之一""大部分"这类空间词。 */
const PROGRESS_BANDS = [
  { max: 0.10, share: { zh: '刚刚起步的一小角', en: 'just a small corner of it' }, note: '几乎还是原样' },
  { max: 0.25, share: { zh: '一小块', en: 'a small portion' }, note: null },
  { max: 0.42, share: { zh: '约三分之一', en: 'about a third' }, note: null },
  { max: 0.58, share: { zh: '一半左右', en: 'about half' }, note: null },
  { max: 0.75, share: { zh: '大部分', en: 'most of it' }, note: null },
  { max: 0.90, share: { zh: '几乎全部', en: 'nearly all of it' }, note: null },
  { max: 1.01, share: { zh: '全部（只剩最后一点没变）', en: 'all of it, only a last sliver left' }, note: '已经接近纯终点' },
];

/** 渐变型轴用"几分之几的长度"，比"60%"好画。 */
const FRACTIONS = [
  { max: 0.20, zh: '不到五分之一', en: 'less than a fifth' },
  { max: 0.30, zh: '约四分之一', en: 'about a quarter' },
  { max: 0.40, zh: '约三分之一', en: 'about a third' },
  { max: 0.60, zh: '约一半', en: 'about half' },
  { max: 0.72, zh: '约三分之二', en: 'about two thirds' },
  { max: 0.88, zh: '约四分之三', en: 'about three quarters' },
  { max: 1.01, zh: '几乎全部', en: 'almost the whole length' },
];

export const STYLES = {
  anime: { zh: '画风：清晰的线稿 + 平涂上色，二次元插画。', en: 'Style: clean line art with flat cel shading, anime illustration.' },
  realistic: { zh: '画风：写实摄影，真实材质与次表面散射，轻微胶片颗粒。', en: 'Style: photorealistic, physically plausible materials and subsurface scattering, slight film grain.' },
  illustration: { zh: '画风：厚涂数字绘画，笔触可见，边缘有取舍。', en: 'Style: painterly digital illustration, visible brushwork, selectively resolved edges.' },
  cinematic: { zh: '画风：电影感打光，强对比，冷暖分离。', en: 'Style: cinematic lighting, strong contrast, warm-cool separation.' },
  threed: { zh: '画风：三维渲染，PBR 材质，干净的轮廓。', en: 'Style: 3D render, PBR materials, clean silhouette.' },
};

/** 过程动词。不是禁用词——是"不能拿来当描述用"的词。 */
const PROCESS_PATTERNS = [
  /正在(变成|转变为|转化为|化为|成为|变形|蜕变|异化)/g,
  /逐渐(变成|转变为|蜕变|异化)/g,
  /(转变|蜕变|异化|同化)中/g,
  /一半(人|怪|兽)/g,
  /\b(in the middle of|mid-?transformation|mid-?transform|transforming into|turning into|becoming)\b/gi,
];

export function detectProcessWords(text) {
  if (typeof text !== 'string' || !text) return [];
  const hits = new Set();
  for (const re of PROCESS_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) hits.add(m[0]);
  }
  return [...hits];
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const bandFor = (p) => PROGRESS_BANDS.find((b) => p <= b.max) || PROGRESS_BANDS[PROGRESS_BANDS.length - 1];
const fractionFor = (p) => FRACTIONS.find((b) => p <= b.max) || FRACTIONS[FRACTIONS.length - 1];

const hasCJK = (s) => /[\u4e00-\u9fff]/.test(String(s || ''));

// 中文里模板插值会留下"到 灰毛家鼠 的"这种空格。中文排版不带这个空格，
// 而提示词是要被编码器逐字读的，多余的空白只会稀释词与词的关系，所以统一抹掉。
// 只抹同一行内「汉字/中文标点」之间的空格（[ \t]，绝不碰换行——换行是分区结构的骨架），
// 英文输出一个字符都不动。
const CJK = '\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';
const TIDY_RE = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g');
const tidy = (s) => String(s)
  .replace(TIDY_RE, '$1')
  .replace(/[ \t]+([，。；：、！？）》」】])/g, '$1')
  .replace(/([（《「【])[ \t]+/g, '$1');

/** 校验并补默认值。硬错误抛错（调用方通常是 CLI），软问题进 warnings。 */
export function normalizeSpec(spec = {}) {
  const lang = String(spec.lang || 'zh').toLowerCase();
  if (lang !== 'zh' && lang !== 'en') throw new Error(`lang 只支持 zh / en，收到 "${spec.lang}"`);

  const errors = [];
  const warnings = [];

  // 单主体写法与多主体写法统一成 subjects[]
  const raw = Array.isArray(spec.subjects) && spec.subjects.length
    ? spec.subjects
    : (spec.from || spec.to ? [{ ...spec, subjects: undefined }] : []);
  if (!raw.length) errors.push('没有主体：至少给 from + to（单主体），或 subjects: [...]（多主体）');

  const subjects = raw.map((s, i) => {
    const tag = raw.length > 1 ? `主体 ${i + 1}` : '主体';
    const isTransition = Boolean(s.from || s.to);
    if (!isTransition) {
      if (!s.desc) errors.push(`${tag}：既没有 from/to，也没有 desc`);
      return { index: i, tag, static: true, name: s.name || '', desc: s.desc || '', position: s.position || '' };
    }
    if (!s.from) errors.push(`${tag}：缺 from（起点是什么）`);
    if (!s.to) errors.push(`${tag}：缺 to（终点是什么）`);
    if (s.from && s.to && String(s.from).trim() === String(s.to).trim()) {
      errors.push(`${tag}：from 和 to 一样，那就不需要中间态了`);
    }
    for (const [key, val] of [['from', s.from], ['to', s.to]]) {
      if (!val) continue;
      if (String(val).trim().length < 3) errors.push(`${tag}.${key} 太短（"${val}"），描述不出材质和形态`);
      const pw = detectProcessWords(val);
      if (pw.length) {
        warnings.push(`${tag}.${key} 里出现了过程动词（${pw.join('、')}）。端点要写"静态长什么样"，不是"正在变成什么"——动词不产生像素，只会让边界变糊。`);
      }
    }
    const progress = clamp01(s.progress === undefined ? 0.6 : Number(s.progress));
    if (!Number.isFinite(Number(s.progress === undefined ? 0.6 : s.progress))) {
      errors.push(`${tag}.progress 必须是 0–1 的数字`);
    }
    if (progress <= 0.03) {
      warnings.push(`${tag}.progress=${progress} 几乎还没开始变。这种图更省的做法是直接画起点，再后期叠加——中间态在这个比例上画出来和被画坏的区别很难分辨。`);
    }
    if (progress >= 0.97) {
      warnings.push(`${tag}.progress=${progress} 几乎已经变完。直接画终点更划算；留 3% 不变在画面上通常看不出来。`);
    }
    const axis = String(s.axis || 'near->far');
    if (!AXES[axis]) {
      errors.push(`${tag}.axis="${axis}" 不认识。可用：${Object.keys(AXES).join('  ')}`);
    }
    const boundary = String(s.boundary || 'crack');
    if (!BOUNDARIES[boundary]) {
      errors.push(`${tag}.boundary="${boundary}" 不认识。可用：${Object.keys(BOUNDARIES).join('  ')}`);
    } else {
      const lacking = (NEEDS[boundary] || []).filter((k) => !s[k]);
      if (lacking.length) {
        const hint = lacking.map((k) => k === 'fromFeature' ? 'from_feature（起点最显眼的材质，如"塑料外壳"）' : 'to_feature（终点最显眼的材质，如"灰毛"）');
        warnings.push(`${tag}：交界机制 ${boundary} 建议给 ${hint.join(' 和 ')}。不给的话模板会退回整段描述，拼出"银发少女顺着短发男性的表面长出来"这种把角色当材质的句子。`);
      }
    }
    if (!s.toDetail) {
      warnings.push(`${tag} 没写 to_detail：模型只能靠 to 那几个字猜"变了之后长什么样"。补上终点最显眼的 2–3 个特征（材质、颜色、轮廓、附属物），效果差别很大。`);
    }
    const keep = Array.isArray(s.keep) ? s.keep.filter(Boolean).map(String)
      : (typeof s.keep === 'string' && s.keep.trim() ? s.keep.split(/[,，;；]/).map((x) => x.trim()).filter(Boolean) : []);
    for (const k of keep) {
      if (s.to && String(s.to).includes(k)) warnings.push(`${tag}.keep 里的"${k}"已经出现在 to 里——一边说不许变、一边说变成它，模型会两边都不听。`);
    }
    return {
      index: i, tag, static: false,
      name: s.name || '',
      from: String(s.from || ''), to: String(s.to || ''),
      fromDetail: s.fromDetail || '', toDetail: s.toDetail || '',
      // 交界模板里用的"起点/终点最显眼的材质特征"，没给就退回整段描述
      fromFeature: s.fromFeature || '', toFeature: s.toFeature || '',
      progress, axis, boundary, keep,
      position: s.position || '',
      note: s.note || '',
    };
  });

  if (errors.length) {
    const e = new Error(errors.join('\n'));
    e.details = errors;
    e.warnings = warnings;
    throw e;
  }

  return {
    lang,
    style: spec.style ? String(spec.style) : '',
    scene: spec.scene ? String(spec.scene) : '',
    canvas: spec.canvas ? String(spec.canvas) : '',
    asymmetry: spec.asymmetry === undefined ? true : Boolean(spec.asymmetry),
    extra: Array.isArray(spec.extra) ? spec.extra.map(String) : (spec.extra ? [String(spec.extra)] : []),
    subjects,
    warnings,
  };
}

function boundaryText(boundaryId, subject, lang) {
  const b = BOUNDARIES[boundaryId];
  const fromFeature = subject.fromFeature || subject.from;
  const toFeature = subject.toFeature || subject.to;
  const tpl = lang === 'zh' ? b.zh : b.en;
  return tpl.replaceAll('{fromFeature}', fromFeature).replaceAll('{toFeature}', toFeature)
    .replaceAll('{from}', subject.from).replaceAll('{to}', subject.to);
}

function buildOneSubject(s, lang, opts) {
  const axis = AXES[s.axis];
  const band = bandFor(s.progress);
  const lines = [];
  const zh = lang === 'zh';

  const namePrefix = s.name ? (zh ? `${s.name}：` : `${s.name}: `) : '';
  const posPrefix = s.position ? (zh ? `（位于${s.position}）` : ` (positioned ${s.position})`) : '';

  if (axis.kind === 'split') {
    lines.push(zh
      ? `${namePrefix}同一具身体${posPrefix}：${s.from}。这一帧只画它变成“${s.to}”的那一帧 —— 是同一个个体在变，不是两只东西并排，不是对比图，不是拼贴。`
      : `${namePrefix}one single body${posPrefix}: ${s.from}. This frame shows only the single frame where it becomes ${s.to} — one individual changing, not two things side by side, not a before-and-after, not a collage.`);
    lines.push(zh
      ? `${axis.zh.landmark}。按这条线分成两段：`
      : `${axis.en.landmark}. Two regions across that line:`);
    const fromD = s.fromDetail || (zh ? `形状、材质与细节原样保留` : `shape, material and details intact`);
    const toD = s.toDetail || (zh ? `已经完全转成 ${s.to} 的形态与材质` : `already fully ${s.to} in form and material`);
    lines.push(zh
      ? `- ${axis.zh.changed}（${band.share.zh}）已经变成“${s.to}”：${toD}`
      : `- ${axis.en.changed} (${band.share.en}) has already become ${s.to}: ${toD}`);
    lines.push(zh
      ? `- ${axis.zh.intact}（其余部分）仍是“${s.from}”原样：${fromD}`
      : `- ${axis.en.intact} (the rest) is still ${s.from}: ${fromD}`);
    lines.push(zh
      ? `- 交界处（这张图的重点）：${boundaryText(s.boundary, s, lang)}`
      : `- at the seam (the whole point of the image): ${boundaryText(s.boundary, s, lang)}`);
    if (opts.asymmetry) {
      lines.push(zh
        ? '- 边界不是一条笔直的裁切线：一侧比另一侧多推进约一指宽，走向略斜，所以看起来是正在往前推。'
        : '- the boundary is not a straight cut: one side has pushed about a finger-width further than the other, so the line runs slightly diagonal and reads as advancing.');
    }
  } else if (axis.kind === 'gradient') {
    const frac = fractionFor(s.progress);
    lines.push(zh
      ? `${namePrefix}同一具身体${posPrefix}：${s.from}。这一帧只画它变成“${s.to}”的中间状态 —— 是一条沿长度方向的连续渐变，不是两段拼接。`
      : `${namePrefix}one single body${posPrefix}: ${s.from}. Only its mid-way state toward ${s.to} — a continuous gradient along its length, not two pieces joined.`);
    const fromD = s.fromDetail || (zh ? `仍是 ${s.from}` : `still ${s.from}`);
    const toD = s.toDetail || (zh ? `已经是 ${s.to}` : `already ${s.to}`);
    lines.push(zh
      ? `- 靠${axis.zh.intact}的${frac.zh}长度：${fromD}`
      : `- the ${frac.en} nearest ${axis.en.intact}: ${fromD}`);
    lines.push(zh
      ? `- ${axis.zh.outward}：${toD}`
      : `- ${axis.en.outward}: ${toD}`);
    lines.push(zh
      ? `- 中段（这张图的重点）：${boundaryText(s.boundary, s, lang)}`
      : `- the middle stretch (the whole point): ${boundaryText(s.boundary, s, lang)}`);
  } else {
    lines.push(zh
      ? `${namePrefix}同一具身体${posPrefix}：${s.from}。这一帧只画它变成“${s.to}”的中间状态 —— 变化从中心向外递减，不是两段拼接。`
      : `${namePrefix}one single body${posPrefix}: ${s.from}. Only its mid-way state toward ${s.to} — the change fades outward from the centre, not two pieces joined.`);
    const fromD = s.fromDetail || (zh ? `仍是 ${s.from}` : `still ${s.from}`);
    const toD = s.toDetail || (zh ? `已经是 ${s.to}` : `already ${s.to}`);
    lines.push(zh
      ? `- ${axis.zh.changed}（${band.share.zh}）：${toD}`
      : `- ${axis.en.changed} (${band.share.en}): ${toD}`);
    lines.push(zh
      ? `- ${axis.zh.intact}：${fromD}`
      : `- ${axis.en.intact}: ${fromD}`);
    lines.push(zh
      ? `- 过渡带（这张图的重点）：${boundaryText(s.boundary, s, lang)}`
      : `- the transition band (the whole point): ${boundaryText(s.boundary, s, lang)}`);
  }

  if (s.keep.length) {
    lines.push(zh ? `必须保持不变：${s.keep.join('、')}。` : `Must stay unchanged: ${s.keep.join(', ')}.`);
  } else {
    lines.push(zh ? '必须保持不变：整体轮廓、比例和姿态。' : 'Must stay unchanged: overall silhouette, proportions and pose.');
  }
  if (s.note) lines.push(String(s.note));
  return lines;
}

function buildStaticSubject(s, lang) {
  const zh = lang === 'zh';
  const head = s.name ? (zh ? `${s.name}：` : `${s.name}: `) : '';
  const pos = s.position ? (zh ? `位于${s.position}，` : `at ${s.position}, `) : '';
  return [`${head}${pos}${s.desc}`];
}

/**
 * 编译一份「中间态」提示词。
 * @returns {{ok:boolean, prompt:string, negative:string, notes:string[], warnings:string[], errors:string[], sections:object}}
 */
export function buildTransition(spec) {
  const n = normalizeSpec(spec);
  const zh = n.lang === 'zh';
  const blocks = [];
  const sections = { frame: '', bodies: [], style: '', scene: '', extra: '' };

  const transitioning = n.subjects.filter((s) => !s.static);
  const statics = n.subjects.filter((s) => s.static);

  if (n.subjects.length > 1) {
    const layout = n.subjects.map((s, i) => {
      const label = s.name || (s.static ? `角色${i + 1}` : `主体${i + 1}`);
      return s.position ? `${label}（${s.position}）` : label;
    });
    const frame = zh
      ? `画面里是 ${n.subjects.length} 个各自独立的角色，${layout.join('、')}。他们互不融合、不是同一个人的分身。`
      : `The frame holds ${n.subjects.length} separate characters: ${layout.join(', ')}. They do not merge, and none of them is a copy of another.`;
    sections.frame = frame;
    blocks.push(frame);
  }

  for (const s of n.subjects) {
    const ls = s.static ? buildStaticSubject(s, n.lang) : buildOneSubject(s, n.lang, n);
    sections.bodies.push(ls.join('\n'));
    blocks.push(ls.join('\n'));
  }

  if (n.style) {
    const st = STYLES[n.style];
    if (!st) {
      // 不认识的风格不拦，原样当自由文本用——它只是画风，不该因为拼错就出不了图
      sections.style = n.style;
      blocks.push(n.style);
    } else {
      sections.style = zh ? st.zh : st.en;
      blocks.push(sections.style);
    }
  }
  if (n.scene) {
    sections.scene = zh ? `背景：${n.scene}。` : `Setting: ${n.scene}.`;
    blocks.push(sections.scene);
  }
  for (const e of n.extra) { blocks.push(e); sections.extra += e + '\n'; }
  if (n.canvas) blocks.push(zh ? `构图：${n.canvas}。` : `Composition: ${n.canvas}.`);

  const negative = zh
    ? '两只并排、前后对比图、分屏、拼贴、重复主体、同一个人的分身、边界像笔直的蒙版线、锯齿状抠图边、两张图拼接'
    : 'two separate creatures, before-and-after comparison, side by side, split screen, collage, duplicated subject, hard straight mask edge, jagged cut-out edge, two images stitched together';

  const notes = [];
  if (transitioning.length) {
    notes.push('动词负责意图，名词负责像素：开头那句"只画这一帧，是同一个个体在变"只是告诉编码器要画变化，真正决定成败的是分区归属和交界材质。');
    notes.push('交界决定成败：只写"一半已变一半未变"出来是一刀切的假缝；上面那条交界描述是这张图真正要画的东西。');
    if (transitioning.some((s) => !s.toDetail)) {
      notes.push('有主体没写 to_detail —— 这是最常见的效果损失点，模型只能靠 to 那几个字猜"变了之后长什么样"。');
    }
  }
  notes.push('负向词只在 CFG > 1 时有作用。FLUX.2 的 cfg 固定在 1，负向整段是白算；MOSS 在 CFG 2.5–3 时有效。');
  if (statics.length) notes.push(`有 ${statics.length} 个角色是静态描述的（没有 from/to），它们不参与变化，只是同框。`);

  return {
    ok: true,
    prompt: zh ? tidy(blocks.join('\n\n')) : blocks.join('\n\n'),
    negative,
    notes,
    warnings: n.warnings,
    errors: [],
    sections,
    axis: transitioning[0]?.axis,
    boundary: transitioning[0]?.boundary,
  };
}

/** 给 human / agent 看的报告（纯文本，已排好版） */
export function formatTransitionReport(r, spec = {}) {
  const out = [];
  if (!r.ok) {
    out.push('✗ 编译失败：');
    for (const e of r.errors) out.push('  · ' + e);
    return out.join('\n');
  }
  out.push('—— 正向提示词 ——', '', r.prompt, '', '—— 负向提示词 ——', '', r.negative, '');
  if (r.warnings.length) {
    out.push('—— 要注意 ——');
    for (const w of r.warnings) out.push('  ⚠ ' + w);
    out.push('');
  }
  if (r.notes.length) {
    out.push('—— 原理备忘 ——');
    for (const n of r.notes) out.push('  · ' + n);
    out.push('');
  }
  out.push(`字数：正向 ${[...r.prompt].length} 字 / 负向 ${[...r.negative].length} 字` +
    (spec.progress !== undefined ? `　progress=${spec.progress}` : ''));
  return out.join('\n');
}

export function describeOptions() {
  const out = ['—— 分区轴 axis ——（箭头 = 变化推进的方向）'];
  for (const [k, v] of Object.entries(AXES)) {
    out.push(`  ${k.padEnd(13)} ${v.kind.padEnd(9)} ${v.zh.changed} 已变 / ${v.zh.intact} 未变`);
  }
  out.push('', '—— 交界机制 boundary ——');
  for (const [k, v] of Object.entries(BOUNDARIES)) {
    out.push(`  ${k.padEnd(9)} 适合：${v.fits}`);
  }
  out.push('', '—— 画风 style ——');
  out.push('  ' + Object.keys(STYLES).join('  '));
  return out.join('\n');
}

/** 三个能直接跑的例子。mouse 是最不容易有歧义的，适合当回归基准。 */
export const EXAMPLES = {
  mouse: {
    label: '鼠标 → 老鼠（无歧义的结构变形）',
    spec: {
      from: '白色哑光塑料无线鼠标',
      to: '灰毛家鼠',
      toDetail: '短而密的灰毛顺着头骨方向贴着，粉色圆耳从毛里立起来，一条细长裸尾从尾部位置垂下来，尾尖还湿着',
      fromDetail: '光滑的哑光塑料壳，左键和中键的凹陷还在，底部滚轮边缘有一圈灰',
      fromFeature: '塑料外壳',
      toFeature: '灰毛',
      progress: 0.6,
      axis: 'near->far',
      boundary: 'crack',
      keep: ['壳上的品牌 logo', '整体尺寸与握持比例'],
      scene: '干净的浅灰摄影棚背景，柔和顶光，浅景深，产品摄影的打光',
      style: 'realistic',
      canvas: '主体居中，占画面三分之二',
    },
  },
  magical: {
    label: '女高中生 → 魔法少女（发光纹路型）',
    spec: {
      from: '穿深蓝水手服的女高中生',
      to: '穿白色魔法少女装的少女',
      toDetail: '白色高领短披肩、胸口一颗发亮的蓝色宝石、裙摆边缘有半透明的光边、发梢浮起',
      fromDetail: '深蓝水手服的衣领和红色领结原样，校服裙褶还在',
      fromFeature: '校服布料',
      toFeature: '发光的魔法装束',
      progress: 0.55,
      axis: 'center->out',
      boundary: 'glow',
      keep: ['脸的轮廓和表情', '发型走向'],
      scene: '夜晚的城市天台，风很大，远处有霓虹',
      style: 'anime',
    },
  },
  alien: {
    label: '人 → 恐怖异形（黏液+顶裂，恐怖向）',
    spec: {
      from: '穿灰色卫衣的成年男性',
      to: '黑色湿亮的异形',
      toDetail: '黑色甲壳一块块交叠、湿润反光、头部狭长没有眼睛、肋骨位置裂开露出内层',
      fromDetail: '灰色卫衣的布纹和袖口抽绳还在，牛仔裤的缝线没断',
      fromFeature: '卫衣布料与皮肤',
      toFeature: '黑色甲壳与触须',
      progress: 0.5,
      axis: 'bottom->top',
      boundary: 'wet',
      keep: ['身高与站姿'],
      scene: '废弃走廊，头顶一根坏掉的荧光灯在闪，地面有积水反光',
      style: 'cinematic',
    },
  },
};
