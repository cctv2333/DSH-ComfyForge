// lib/promptlint.mjs — H3 r2v 提示词校验器
//
// 设计原则（回应「要不要上小模型」）：
//   1. 能用规则判的，绝不给模型判。结构、段落、时间码、帧数、引用闭合、字段缺失——
//      这些有确定答案，规则的判准率是 100%，小模型只会引入假阳性。
//   2. 只有「语义层」才问模型：手分工是否自相矛盾、动作是否物理上做不到、
//      风格声明是否与内容冲突。这一层规则写不出来。
//   3. 模型永远是**可选**的，而且只产出 warn 级建议，不阻断。默认一个字节都不下载，
//      也不自带任何运行时——接任何 OpenAI 兼容端点（Ollama / llama.cpp server / 远程）。
//   4. 没配端点时，把「缺什么、多大、怎么装」原样打印出来，不静默跳过。
import { existsSync, readFileSync } from 'node:fs';

export const SECTIONS = [
  ['subject_definitions', true, '主体定义：<Picture n> 是什么、<Subject n> 是谁'],
  ['summary', false, '全局摘要：时长、动作顺序、物理约束'],
  ['retention_analysis', false, '保留分析：哪些必须保住、哪些允许变'],
  ['detailed_description', true, '分镜正文：全局风格段 + [Shot n]'],
  ['overall_soundscape', true, '逐镜声音清单'],
  ['non_diegetic_music', true, '配乐：BPM + 乐器 + 卡点'],
];

const RE_SECTION = /^([a-z][a-z_]{2,40})\s*:\s*(.*)$/i;
const KNOWN = new Set(SECTIONS.map(([s]) => s));
const RE_AT = /\bAt\s+(\d{1,2}):(\d{2})(?:\.(\d{3}))?\s*,/g;
const RE_UNTIL = /\buntil\s+(\d{1,2}):(\d{2})(?:\.(\d{3}))?/gi;

/** 秒 → H3 合法帧数（5 + 17k） */
export function framesFor(seconds) {
  const raw = Math.max(5, Math.round(seconds * 24));
  return raw + ((5 - (raw % 17)) % 17);
}

function toSec(m, s, ms) {
  return (+m) * 60 + (+s) + (ms ? +(('0.' + ms)) : 0);
}

/**
 * 纯规则校验。零依赖、零网络、毫秒级。
 * @param {string} text 提示词全文
 * @param {object} [o]
 * @param {number} [o.seconds] 目标时长（有就校验帧数与末尾时间码）
 * @param {number} [o.refImages] 实际提供的参考图数量（有就校验 <Picture n> 是否多引用）
 * @returns {{ok:boolean, score:number, issues:Array, stats:object}}
 */
export function lintPrompt(text, o = {}) {
  const src = String(text ?? '');
  const issues = [];
  const add = (level, code, msg, hint) => issues.push({ level, code, msg, ...(hint ? { hint } : {}) });

  if (!src.trim()) {
    add('error', 'empty', '提示词是空的');
    return { ok: false, score: 0, issues, stats: {} };
  }

  // ── 1. 段落结构 ──
  // 段名不要求独占一行（官方模板就是「…定格。overall_soundscape: …」写在同一行），
  // 只要出现「已知段名:」就认；内容从冒号后算到下一个段名。
  const SEC_RE = new RegExp(`(${[...KNOWN].join('|')})\\s*:`, 'gi');
  // 中文别名也认（官方模板就是「资产角色：」开头）
  const ALIAS = { '资产角色': 'subject_definitions', '角色设定': 'subject_definitions', '主体定义': 'subject_definitions' };
  const ALIAS_RE = /(资产角色|角色设定|主体定义)\s*[:：]/g;
  const hits = [
    ...[...src.matchAll(SEC_RE)].map((m) => ({ name: m[1].toLowerCase(), at: m.index, bodyStart: m.index + m[0].length })),
    ...[...src.matchAll(ALIAS_RE)].map((m) => ({ name: ALIAS[m[1]], at: m.index, bodyStart: m.index + m[0].length })),
  ].sort((a, b) => a.at - b.at);
  const names = hits.map((h) => h.name);
  const secMap = new Map();
  hits.forEach((h, i) => {
    if (secMap.has(h.name)) return; // 同名重复出现时以第一次为准
    secMap.set(h.name, src.slice(h.bodyStart, i + 1 < hits.length ? hits[i + 1].at : src.length));
  });
  for (const [name, required, desc] of SECTIONS) {
    if (!secMap.has(name)) {
      // 缺段只算"表达力不足"，不阻断——短提示词也能出片，只是不够稳
      add('warn', 'missing_section', `缺段落 ${name}:（${desc}）`,
        required ? '进阶写法建议写全六段；短提示词也能跑，但二采没东西可重建' : '非必需，但补上能显著改善一致性');
    }
  }
  const unknown = [...src.matchAll(/^([a-z][a-z_]{2,40})\s*:\s*$/gim)]
    .map((m) => m[1].toLowerCase()).filter((n) => !KNOWN.has(n));
  if (unknown.length) add('info', 'unknown_section', `有非标准段名：${[...new Set(unknown)].join(', ')}`, '引擎只认六段，其余会当正文');

  // 段序
  const firstIdx = (n) => names.indexOf(n);
  if (names.length > 1 && firstIdx('subject_definitions') > 0) {
    add('warn', 'section_order', 'subject_definitions 不在最前，参考图可能没被先定义');
  }
  for (const tail of ['overall_soundscape', 'non_diegetic_music']) {
    if (firstIdx(tail) >= 0 && firstIdx('detailed_description') >= 0 && firstIdx(tail) < firstIdx('detailed_description')) {
      add('warn', 'section_order', `${tail} 出现在分镜之前，应放在最后`);
    }
  }
  for (const [name, body] of secMap) {
    if (!body.trim()) add('warn', 'empty_section', `段落 ${name} 是空的`);
  }

  // ── 2. 指代闭合 ──
  const picRefs = [...new Set([...src.matchAll(/<Picture\s+(\d+)>/gi)].map((m) => +m[1]))].sort((a, b) => a - b);
  const picDefs = new Set();
  const subjRefs = new Set();
  const subjDefs = new Set();
  const subjSection = secMap.get('subject_definitions') || '';
  for (const line of subjSection.split(/\r?\n/)) {
    const p = line.match(/^\s*<Picture\s+(\d+)>/i);
    if (p && !line.includes(' is ')) picDefs.add(+p[1]);
    const s = line.match(/^\s*<Subject\s+(\d+)>\s+is/i);
    if (s) subjDefs.add(+s[1]);
  }
  for (const n of [...src.matchAll(/<Subject\s+(\d+)>/gi)]) subjRefs.add(+n[1]);
  const picUsedTotal = new Set([...src.matchAll(/<Picture\s+(\d+)>/gi)].map((m) => +m[1]));

  if (picRefs.length && !subjSection.trim()) {
    add('error', 'picture_undefined', '用了 <Picture n> 但没有任何「先介绍这张图」的段落',
      '每张参考图都要先写一句「<Picture 1> 是……」，否则模型不知道它指什么');
  }
  // 必须在分镜之前先介绍过，否则等于"用了没定义"
  const detailStart = hits.find((h) => h.name === 'detailed_description')?.at ?? src.length;
  const picBefore = new Set([...src.matchAll(/<Picture\s+(\d+)>/gi)].filter((m) => m.index < detailStart).map((m) => +m[1]));
  const picInDetail = new Set([...src.matchAll(/<Picture\s+(\d+)>/gi)].filter((m) => m.index >= detailStart).map((m) => +m[1]));
  if (picInDetail.size && !picBefore.size) {
    add('error', 'picture_undefined', '分镜里引用了 <Picture n>，但分镜之前没有介绍过这些图',
      '在第一个段落里逐张写「<Picture 1> 是……」');
  }
  for (const n of picInDetail) {
    if (picBefore.size && !picBefore.has(n)) add('warn', 'picture_undefined_one', `<Picture ${n}> 在分镜里用到，但前面没介绍`);
  }
  if (o.refImages != null && picRefs.length && Math.max(...picRefs) > o.refImages) {
    add('error', 'picture_count', `提示词引用了 <Picture ${Math.max(...picRefs)}>，但实际只给了 ${o.refImages} 张图`,
      '编号必须落在实际参考图范围内，否则这张"图"是空的');
  }
  if (o.refImages != null && o.refImages > 0 && picRefs.length === 0) {
    add('warn', 'picture_unused', `给了 ${o.refImages} 张参考图，但提示词里没有 <Picture n> 指代`, '不指代等于放弃身份锚定');
  }
  if (subjRefs.size && subjDefs.size === 0) {
    add('error', 'subject_undefined', '用了 <Subject n> 但没有一行以「<Subject n> is」定义');
  }
  for (const n of subjRefs) {
    if (subjDefs.size && !subjDefs.has(n)) add('warn', 'subject_undefined_one', `<Subject ${n}> 被引用但没定义`);
  }

  // ── 3. 分镜与时间码 ──
  // 只在 detailed_description 里、且必须行首，才算分镜标记。
  // （retention_analysis 里也会写 "(appears in [Shot 1] through [Shot 5])"，那是引用不是分镜）
  const detail = secMap.get('detailed_description') || src;
  const shots = [...detail.matchAll(/\[Shot\s+(\d+)\]/gim)].map((m) => ({ n: +m[1], at: m.index }));
  const shotNums = shots.map((s) => s.n);
  if (shots.length === 0) {
    add('warn', 'no_shots', '没有 [Shot n] 分镜标记（且须行首）', '单镜长片也建议写 [Shot 1]，否则模型容易中段漂移');
  } else {
    shotNums.forEach((n, i) => {
      if (n !== i + 1) add('warn', 'shot_numbering', `分镜编号不连续：第 ${i + 1} 个是 [Shot ${n}]`);
    });
    if (new Set(shotNums).size !== shotNums.length) add('warn', 'shot_duplicate', '有重复的分镜编号');
  }

  const ats = [...src.matchAll(RE_AT)].map((m) => toSec(m[1], m[2], m[3]));
  let lastAt = -1;
  for (const t of ats) {
    if (t <= lastAt) add('error', 'timecode_order', `时间码不是递增：${t}s 出现在 ${lastAt}s 之后`, 'At 时间码必须严格递增');
    lastAt = Math.max(lastAt, t);
  }
  const untils = [...src.matchAll(RE_UNTIL)].map((m) => toSec(m[1], m[2], m[3]));
  if (ats.length && shots.length >= 2 && ats.length !== shots.length - 1) {
    add('info', 'timecode_count', `有 ${shots.length} 个分镜但只有 ${ats.length} 个 At 时间码（第一镜默认 00:00，其余每镜一个）`);
  }
  const lastShot = Math.max(0, ...ats);
  if (o.seconds) {
    const end = untils.length ? untils[untils.length - 1] : null;
    if (end != null && Math.abs(end - o.seconds) > 1) {
      add('warn', 'duration_mismatch', `提示词收在 ${end}s，但目标时长是 ${o.seconds}s`, '末尾写 hold until 00:0X.000 对齐目标时长');
    }
    if (end == null && lastShot > 0 && o.seconds - lastShot > 3) {
      add('info', 'no_end_timecode', `最后一个时间码是 ${lastShot}s，没写 until ${o.seconds}s`);
    }
    const f = framesFor(o.seconds);
    add('info', 'frames', `目标 ${o.seconds}s → H3 合法帧数 ${f}（5+17k，实际 ${(f / 24).toFixed(2)}s）`);
  }

  // ── 4. 每镜的必备约束 ──
  if (shots.length) {
    const blocks = shots.map((s, i) => ({
      n: s.n,
      text: detail.slice(s.at, i + 1 < shots.length ? shots[i + 1].at : detail.length),
    }));
    for (const b of blocks) {
      const t = b.text;
      if (!/(hand\s*assignment|hand\s*order|both\s+hands|left\s+hand|right\s+hand|左手|右手|两只手|双手|单手)/i.test(t)) {
        add('warn', 'shot_no_hands', `[Shot ${b.n}] 没写手的分工`, '写「Hand assignment: 左手…；右手…」能显著减少多手/手崩');
      }
      if (!/(sound|音效|声音|声画|Sound sync)/i.test(t)) {
        add('info', 'shot_no_sound', `[Shot ${b.n}] 没写 Sound sync`);
      }
      if (t.replace(/\s/g, '').length < 120) {
        add('warn', 'shot_too_short', `[Shot ${b.n}] 只有 ${t.replace(/\s/g, '').length} 字，太薄`, '二采要靠这些字重建细节；每镜 200 字以上更稳');
      }
    }
  }

  // ── 5. 措辞强度 ──
  const absolutes = (src.match(/\b(EVERY|ALL|ONLY|exactly|never|no)\b|全部|完全|绝不|一次性/gi) || []).length;
  const negations = (src.match(/\b(no|never|not|without)\b|不要|禁止|永不/gi) || []).length;
  if (absolutes < 3) add('warn', 'few_absolutes', `绝对化措辞只有 ${absolutes} 处`, '「切完/倒完」这类完成度必须写死，否则只演一半');
  if (negations < 3) add('info', 'few_negations', `否定列举只有 ${negations} 处`, '把常见错误点名（no third hand / never enters the wok）比正面描述有效');

  // ── 6. 风格与媒介声明 ──
  if (!/(cel[- ]?shaded|2D|写实|photoreal|rendered|画风|风格)/i.test(subjSection)) {
    add('info', 'no_style', 'subject_definitions 里没有媒介/风格声明', '写实 vs 赛璐璐要在角色条目里钉死，否则风格漂移');
  }
  if (!/(BPM|bpm|速度|拍)/.test(src)) add('info', 'no_bpm', 'non_diegetic_music 没写 BPM', '没有节拍，配乐容易发闷、和剪辑点脱节');

  // ── 计分：错误重罚、警告轻罚、提示几乎不罚；分数不因措辞类提示归零 ──
  const w = { error: 25, warn: 4, info: 0.5 };
  const penalty = issues.reduce((s, it) => s + (w[it.level] || 0), 0);
  const stats = {
    chars: src.length,
    charsPerSecond: o.seconds ? +(src.length / o.seconds).toFixed(1) : null,
    sections: names,
    shots: shots.length,
    pictures: picRefs.length,
    subjects: subjDefs.size,
    absolutes, negations,
  };
  if (o.seconds && stats.charsPerSecond != null && stats.charsPerSecond < 100) {
    add('warn', 'too_thin', `每秒只有 ${stats.charsPerSecond} 字`, '进阶版 15s 用了 11270 字（约 750 字/秒）；太薄二采没东西可重建');
  }
  const errs = issues.filter((i) => i.level === 'error').length;
  const warns = issues.filter((i) => i.level === 'warn').length;
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  return {
    ok: errs === 0,
    verdict: errs ? 'blocked' : warns > 3 ? 'usable_with_warnings' : warns ? 'ok' : 'clean',
    score, issues, stats,
    counts: { errors: errs, warnings: warns, infos: issues.length - errs - warns },
  };
}

function sectionText(src, name) {
  const m = src.match(new RegExp('^' + name + '\\s*:[ \\t]*(.*)$', 'im'));
  if (!m) return '';
  const start = m.index + m[0].length;
  const rest = src.slice(start);
  const next = rest.search(/^[a-z][a-z_]{2,40}\s*:/im);
  const body = next < 0 ? rest : rest.slice(0, next);
  return (m[1] ? m[1] + '\n' : '') + body;
}

// ─────────────────────────────────────────────────────────────
// 可选的语义层：任何 OpenAI 兼容端点（Ollama / llama.cpp server / 远程）
// 不下载、不捆绑运行时；没配就告诉用户缺什么、多大、怎么装。
// ─────────────────────────────────────────────────────────────
const DEFAULT_ENDPOINTS = [
  'http://127.0.0.1:11434/v1/chat/completions', // Ollama
  'http://127.0.0.1:8080/v1/chat/completions',  // llama.cpp server
];

export const LLM_SETUP = [
  '语义层需要一个小模型端点（规则层不需要，已经跑完了）。三种办法，任选其一：',
  '  ① Ollama（最省事）：装好 Ollama 后执行 `ollama pull qwen2.5:1.5b-instruct`（约 1.0GB），',
  '     端点自动是 http://127.0.0.1:11434/v1/chat/completions，不用配。',
  '  ② llama.cpp server：下一个 Qwen2.5-1.5B-Instruct-Q4_K_M.gguf（约 1.0GB），',
  '     `llama-server -m 该文件 --port 8080`，端点同上。',
  '  ③ 远程 OpenAI 兼容服务：设 PROMPT_LINT_LLM_URL / PROMPT_LINT_LLM_MODEL / PROMPT_LINT_LLM_KEY。',
  '注意：本机 RAM 只剩约 2GB，模型会和 ComfyUI 抢内存；出片时建议别开，写完提示词再单跑。',
].join('\n');

/** 探测有没有可用端点（GET /models，1.5 秒超时） */
export async function probeLLM(url) {
  const candidates = url ? [url] : [process.env.PROMPT_LINT_LLM_URL, ...DEFAULT_ENDPOINTS].filter(Boolean);
  for (const u of candidates) {
    const base = u.replace(/\/chat\/completions$/, '');
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch(`${base}/models`, { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      const models = (j.data || []).map((m) => m.id);
      return { ok: true, url: u, models };
    } catch { /* 试下一个 */ }
  }
  return { ok: false, url: null, models: [] };
}

const SEMANTIC_PROMPT = `你是视频生成提示词审稿人。只做「机械规则查不出来」的判断，不要重写、不要评价文笔。
给你一段 MiniMax H3 参考图生视频（r2v）提示词，请只找这几类问题：
1. 左右手分工自相矛盾（同一只手同时做两件事、或中途没松手就换物）。
2. 物理上做不到的动作（道具进了不该进的地方、数量对不上）。
3. 风格声明与内容冲突（说写实又要求赛璐璐平涂之类）。
4. 前后镜头的主体/服装/场景不一致。
没有就返回空数组。只输出 JSON 数组，每项 {"level":"warn","msg":"一句话问题","hint":"怎么改"}，最多 5 项。`;

/** 语义层校验（可选）。失败时返回 {skipped, reason}，不影响规则层结果。 */
export async function lintWithLLM(text, { url, model, key } = {}) {
  const probe = await probeLLM(url);
  if (!probe.ok) return { skipped: true, reason: 'no_endpoint', setup: LLM_SETUP };
  const endpoint = probe.url;
  const useModel = model || process.env.PROMPT_LINT_LLM_MODEL || probe.models[0];
  if (!useModel) return { skipped: true, reason: 'no_model', setup: LLM_SETUP };
  const body = {
    model: useModel,
    temperature: 0,
    max_tokens: 500,
    messages: [
      { role: 'system', content: SEMANTIC_PROMPT },
      { role: 'user', content: String(text).slice(0, 12000) },
    ],
  };
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key || process.env.PROMPT_LINT_LLM_KEY ? { authorization: `Bearer ${key || process.env.PROMPT_LINT_LLM_KEY}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { skipped: true, reason: `http_${r.status}`, setup: LLM_SETUP };
    const j = await r.json();
    const raw = j.choices?.[0]?.message?.content ?? '';
    const m = raw.match(/\[[\s\S]*\]/);
    const arr = m ? JSON.parse(m[0]) : [];
    return {
      skipped: false, endpoint, model: useModel,
      issues: (Array.isArray(arr) ? arr : []).slice(0, 5).map((x) => ({
        level: 'warn', code: 'semantic', msg: String(x.msg || x.issue || '').slice(0, 200),
        ...(x.hint ? { hint: String(x.hint).slice(0, 200) } : {}),
        source: 'llm',
      })),
    };
  } catch (e) {
    return { skipped: true, reason: e.message?.slice(0, 80) || 'request_failed', setup: LLM_SETUP };
  }
}

/** 从文件读提示词：纯文本，或带 prompt 字段的 JSON 配置 */
export function readPromptFile(p) {
  if (!existsSync(p)) throw new Error(`文件不存在：${p}`);
  const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  if (/^\s*\{/.test(raw)) {
    const j = JSON.parse(raw);
    return { text: j.prompt ?? j.text ?? '', meta: j };
  }
  return { text: raw, meta: {} };
}
