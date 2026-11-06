// lib/h3protocol.mjs — H3 提示词**结构**校验
//
// 边界（照官方规范定的，不是我们的偏好）：
//   · 本模块只判断"结构对不对"，**不解读内容、不评价文案、不改写正文**。
//   · 报错只带**位置与形状**（第几镜、什么标记、期望什么），不把正文回灌进上下文。
//   · 不确定的一律标 warn 而不是 error —— 结构能确定的才敢判死。
//
// 规范出处：MiniMax-AI/MiniMax-H3  skills/h3-prompt-writing/references/
//   base-en.txt（三段式 T2VA/I2VA/FL2VA/L2VA）
//   ref-en.txt （六段式全参考 Ref2VA）
// 对齐记录见 docs/H3-官方协议对齐报告-2026-11-06.md
//
// 为什么要有它：ComfyUI 的 POST /prompt 只校验节点类型/必填/类型，
// 提示词写错它一句话不说，跑五分钟给你一条跑偏的片子。

/** 六个字段，顺序固定（全参考模式） */
export const FIELDS_FULL = Object.freeze([
  'subject_definitions', 'summary', 'retention_analysis',
  'detailed_description', 'overall_soundscape', 'non_diegetic_music',
]);

/** 三个字段（无参考图 / 关键帧模式） */
export const FIELDS_BASE = Object.freeze([
  'integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music',
]);

/** retention 标记：可见内容 4 个 */
export const RETENTION_VISUAL = Object.freeze([
  'fully_preserved', 'partially_preserved', 'attribute_transfer', 'weak_reference',
]);

/** retention 标记：音频 4 个 */
export const RETENTION_AUDIO = Object.freeze([
  'fully_copy', 'partially_copy', 'reference', 'weak_reference',
]);

const REF_KINDS = ['Subject', 'Picture', 'Video', 'Audio'];
const ALL_FIELDS = [...new Set([...FIELDS_FULL, ...FIELDS_BASE])];

/** 配乐里不许出现的抽象情绪词（官方：只写乐器/速度/节奏/强弱） */
const MOOD_WORDS = /(\bmood\b|\bemotional(ly)?\b|\btension\b|\btense\b|\bsad\b|\bhappy\b|\bjoyful\b|\bmelanchol\w*\b|\bepic\b|\bheartbreak\w*\b|悲伤|紧张|抒情|激昂|忧伤|温馨)/i;

const SHOT_RE = /\[Shot\s*(\d+)\]/g;
const CUT_RE = /^\s*At\s+(\d{2}):(\d{2})\.(\d{3})\s*,/;
const DIALOGUE_OPEN = /<d>/g;
const DIALOGUE_CLOSE = /<\/d>/g;
const SPEAKER_RE = /\((S\d+(?:\s*,\s*S\d+)*)\)/g;
const LABEL_RE = new RegExp(`<(${REF_KINDS.join('|')})\\s+(\\d+)>`, 'g');

const isFieldLine = (line) => {
  const m = /^([a-z_]+):\s*/.exec(line);
  return m && ALL_FIELDS.includes(m[1]) ? m[1] : null;
};

/** 把文本切成字段块；返回 [{ name, body, line }]，保持出现顺序 */
export function splitSections(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let current = null;
  lines.forEach((line, index) => {
    const name = isFieldLine(line);
    if (name) {
      current = { name, line: index + 1, lines: [] };
      sections.push(current);
      const rest = line.slice(line.indexOf(':') + 1).trim();
      if (rest) current.lines.push(rest);
    } else if (current) {
      current.lines.push(line);
    }
  });
  return sections.map((s) => ({ name: s.name, line: s.line, body: s.lines.join('\n').trim() }));
}

const countSentences = (text) => String(text)
  .split(/(?<=[.!?。！？])\s+/)
  .map((s) => s.trim())
  .filter(Boolean).length;

/**
 * @param {string} text 提示词正文
 * @param {{ durationSec?: number }} [opts]
 * @returns {{ ok: boolean, mode: 'full'|'base'|'unknown', fields: string[], shots: Array<{ n:number, at:number|null }>, problems: Array<{level:'error'|'warn', code:string, where:string, message:string}> }}
 */
export function validateH3Prompt(text, { durationSec } = {}) {
  const problems = [];
  const add = (level, code, where, message) => problems.push({ level, code, where, message });

  const raw = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!raw.trim()) {
    add('error', 'empty', '全文', '提示词是空的');
    return { ok: false, mode: 'unknown', fields: [], shots: [], problems };
  }

  // ── 1. 字段与顺序 ────────────────────────────────────────────────────────
  const sections = splitSections(raw);
  const names = sections.map((s) => s.name);
  let mode = 'unknown';
  if (names.length === FIELDS_FULL.length && FIELDS_FULL.every((f, i) => names[i] === f)) mode = 'full';
  else if (names.length === FIELDS_BASE.length && FIELDS_BASE.every((f, i) => names[i] === f)) mode = 'base';
  else {
    const expected = names.includes('subject_definitions') ? FIELDS_FULL : FIELDS_BASE;
    const missing = expected.filter((f) => !names.includes(f));
    const extra = names.filter((f) => !expected.includes(f));
    const orderOk = names.filter((f) => expected.includes(f)).every((f, i) => f === expected[i]);
    add('error', 'fields', '字段',
      `字段不合法。期望按序：${expected.join(' → ')}`
      + (missing.length ? `；缺：${missing.join(', ')}` : '')
      + (extra.length ? `；多：${extra.join(', ')}` : '')
      + (!missing.length && !extra.length && !orderOk ? '；顺序与规范不一致' : ''));
  }

  const byName = Object.fromEntries(sections.map((s) => [s.name, s.body]));
  const isFull = mode === 'full' || names.includes('subject_definitions');

  // ── 2. 禁止负向字段（H3 没有负向栏）──────────────────────────────────────
  for (const line of raw.split('\n')) {
    if (/^\s*negative(_?prompt)?\s*:/i.test(line)) {
      add('error', 'negative', '字段', 'H3 没有负向栏，不得出现 negative / negative_prompt 字段');
    }
  }

  // ── 3. 分镜与切点 ────────────────────────────────────────────────────────
  const bodyField = byName.detailed_description ?? byName.integrated_multimodal_description ?? '';
  const shots = [];
  if (bodyField) {
    const marks = [...bodyField.matchAll(SHOT_RE)].map((m) => ({ n: Number(m[1]), index: m.index ?? 0, text: m[0] }));
    if (!marks.length) add('warn', 'no-shots', '正文', '正文里没有 [Shot N] 标记（单镜可接受，但要确认是否符合预期）');
    // 第一镜隐式落在 0 秒，所以切点要跟「上一镜的实际时刻」比，第一次比较对象是 0
    let prevAt = 0;
    marks.forEach((m, i) => {
      const tail = bodyField.slice(m.index + m.text.length);
      const cut = CUT_RE.exec(tail);
      const at = cut ? Number(cut[1]) * 60 + Number(cut[2]) + Number(cut[3]) / 1000 : null;
      shots.push({ n: m.n, at });
      if (m.n !== i + 1) add('error', 'shot-seq', `第 ${i + 1} 个标记`, `分镜必须从 1 起连续：第 ${i + 1} 个写的是 [Shot ${m.n}]`);
      if (i === 0) {
        if (cut) add('error', 'shot1-at', '[Shot 1]', '第一镜不写时间码（默认 0 秒）');
      } else {
        if (!cut) add('error', 'cut-missing', `[Shot ${m.n}]`, '第二镜起必须以 At MM:SS.mmm, 开头');
        else if (at !== null && at <= prevAt) {
          add('error', 'cut-order', `[Shot ${m.n}]`, '切点必须严格递增（且晚于上一镜）');
        }
      }
      if (at !== null) {
        prevAt = at;
        if (Number.isFinite(durationSec) && at >= durationSec) {
          add('error', 'cut-out-of-range', `[Shot ${m.n}]`, `切点超出时长（${durationSec}s）`);
        }
      }
    });
  } else if (names.length) {
    add('error', 'body-missing', '正文', '缺少 integrated_multimodal_description / detailed_description');
  }

  // ── 4. 对白标签闭合 ──────────────────────────────────────────────────────
  const opens = (raw.match(DIALOGUE_OPEN) || []).length;
  const closes = (raw.match(DIALOGUE_CLOSE) || []).length;
  if (opens !== closes) add('error', 'dialogue-unclosed', '对白', `<d> 与 </d> 数量不一致（${opens} / ${closes}）`);

  // ── 5. 声源编号：(S1)(S2) 按首次发声顺序 ─────────────────────────────────
  const speakers = [];
  for (const m of raw.matchAll(SPEAKER_RE)) {
    for (const part of m[1].split(',')) {
      const n = Number(part.trim().slice(1));
      if (!speakers.includes(n)) speakers.push(n);
    }
  }
  const expectedOrder = speakers.slice().sort((a, b) => a - b);
  if (speakers.join(',') !== expectedOrder.join(',')) {
    add('error', 'speaker-order', '声源', `声源编号必须按首次发声顺序 1,2,3… 出现（实际首次出现顺序：${speakers.join(' → ')}）`);
  }

  // 每个 <d> 之前（同一镜内）要有声源：这是官方"说话人必须明确"的机械形态
  if (bodyField) {
    const segments = bodyField.split(SHOT_RE);
    // split 带捕获组 → [前置, '1', 段1, '2', 段2, ...]
    for (let i = 1; i < segments.length; i += 2) {
      const shotNo = segments[i];
      const seg = segments[i + 1] ?? '';
      for (const d of seg.matchAll(DIALOGUE_OPEN)) {
        const before = seg.slice(0, d.index);
        if (!SPEAKER_RE.test(before) && !/<Audio\s+\d+>/.test(before)) {
          add('warn', 'dialogue-no-speaker', `[Shot ${shotNo}]`, '<d> 之前没有 (S1) 或 <Audio N>，说话人不明确');
        }
        SPEAKER_RE.lastIndex = 0;
      }
    }
  }

  // ── 6. 参考标签必须先定义（全参考模式）───────────────────────────────────
  const defs = byName.subject_definitions ?? '';
  const defined = new Set([...defs.matchAll(LABEL_RE)].map((m) => `${m[1]} ${m[2]}`));
  const definedSubjects = new Set([...defined].filter((s) => s.startsWith('Subject')).map((s) => s));
  if (isFull) {
    const used = new Set();
    for (const m of raw.matchAll(LABEL_RE)) {
      // subject_definitions 自己的条目是"定义"，不算使用
      const key = `${m[1]} ${m[2]}`;
      if (!defined.has(key)) used.add(key);
    }
    if (used.size) {
      add('error', 'label-undefined', '参考标签', `这些标签没有在 subject_definitions 里定义：${[...used].sort().join(', ')}`);
    }
    if (!definedSubjects.size) add('warn', 'no-subjects', 'subject_definitions', '没有定义任何 <Subject N>');
  } else {
    const stray = new Set([...raw.matchAll(LABEL_RE)].map((m) => `${m[1]} ${m[2]}`).filter((k) => !k.startsWith('Picture')));
    if (stray.size) add('warn', 'labels-in-base', '参考标签', `三段式里出现了全参考标签：${[...stray].sort().join(', ')}`);
  }

  // ── 7. 图片单列条目（仅帧锚才该单列）─────────────────────────────────────
  for (const line of defs.split('\n')) {
    if (/^\s*<Picture\s+\d+>\s+is\b/i.test(line)) {
      add('warn', 'picture-standalone', 'subject_definitions',
        '<Picture N> 被单列成条目。官方：只有它本身充当某镜首帧/关键帧/末帧/构图锚时才单列，'
        + '仅用于定义角色/场景/风格时应写进对应 <Subject N>');
      break;
    }
  }

  // ── 8. 两条声音字段的职责 ────────────────────────────────────────────────
  const soundscape = byName.overall_soundscape;
  if (soundscape !== undefined) {
    if (!soundscape) add('error', 'soundscape-empty', 'overall_soundscape', '这一段不能为空（全静音才写 N/A）');
    else if (!/^N\/A\b/i.test(soundscape)) {
      const n = countSentences(soundscape);
      if (n > 4) add('warn', 'soundscape-long', 'overall_soundscape',
        `写了 ${n} 句，官方要求 1–4 句的**整段概括**；逐镜同步音效应留在正文对应镜头里`);
      if (/\[Shot\s*\d+\]|Shot\s*\d+\s*[—–-]/i.test(soundscape)) {
        add('warn', 'soundscape-per-shot', 'overall_soundscape',
          '出现了逐镜列举。官方：这一段是整段声学概括，不是逐镜音效清单');
      }
    }
  }

  const music = byName.non_diegetic_music;
  if (music !== undefined) {
    if (!music) add('error', 'music-empty', 'non_diegetic_music', '没有配乐时写 N/A，不要留空');
    else if (!/^N\/A\b/i.test(music)) {
      const n = countSentences(music);
      if (n > 3) add('warn', 'music-long', 'non_diegetic_music', `写了 ${n} 句，官方要求 1–3 句`);
      if (MOOD_WORDS.test(music)) add('warn', 'music-mood', 'non_diegetic_music',
        '出现了抽象情绪词。官方：只写乐器/速度/节奏/强弱，不解释配乐的情感作用');
    }
  }

  // ── 9. retention_analysis 的标记集 ───────────────────────────────────────
  const retention = byName.retention_analysis;
  if (retention !== undefined) {
    for (const line of retention.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const head = /^<(\w+)\s+(\d+)>/.exec(line);
      if (!head) { add('warn', 'retention-line', 'retention_analysis', '每一行都应以 <Subject N> / <Picture N> / <Audio N> 开头'); continue; }
      const kind = head[1];
      const pool = kind === 'Audio' ? RETENTION_AUDIO : RETENTION_VISUAL;
      const marker = pool.find((m) => new RegExp(`\\b${m}\\b`).test(line));
      if (!marker) {
        add('error', 'retention-marker', 'retention_analysis',
          `<${kind} ${head[2]}> 这一行没有合法标记。${kind === 'Audio' ? '音频' : '可见内容'}可用：${pool.join(' / ')}`);
      }
      if (kind !== 'Audio' && RETENTION_AUDIO.some((m) => new RegExp(`\\b${m}\\b`).test(line)) && !marker) {
        add('warn', 'retention-wrong-pool', 'retention_analysis', '可见内容用了音频标记');
      }
    }
  }

  const ok = !problems.some((p) => p.level === 'error');
  return { ok, mode, fields: names, shots, problems };
}

/** 把问题清单渲染成给 AI 看的短文本：带位置、不带正文 */
export function formatH3Problems(problems, limit = 12) {
  if (!problems?.length) return '（没有发现问题）';
  const order = { error: 0, warn: 1 };
  const sorted = [...problems].sort((a, b) => order[a.level] - order[b.level]);
  const shown = sorted.slice(0, limit).map((p) => `[${p.level}] ${p.where}：${p.message}`);
  if (sorted.length > limit) shown.push(`…另有 ${sorted.length - limit} 条`);
  return shown.join('\n');
}
