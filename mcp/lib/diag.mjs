// lib/diag.mjs — 从 ComfyUI 日志与异常里提取「到底哪一步炸了」
import { existsSync, readFileSync, statSync } from 'node:fs';
import { LOG_PATH } from './comfy.mjs';

const NOISE = /^\s*$|^\[INFO\]|^\[DEBUG\]/;

export function readLog({ lines = 120, errorsOnly = false } = {}) {
  // 远程模式（没有 COMFY_ROOT/COMFY_LOG）读不到日志：如实返回，不抛异常
  if (!LOG_PATH || !existsSync(LOG_PATH)) {
    return { path: LOG_PATH, exists: false, text: '', matched: [], reason: LOG_PATH ? '文件不存在' : '未配置 COMFY_LOG' };
  }
  const size = statSync(LOG_PATH).size;
  const raw = readFileSync(LOG_PATH, 'utf8');
  const arr = raw.split(/\r?\n/);
  const tail = arr.slice(-Math.max(lines, 50));
  const matched = arr
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /ERROR|Error|Traceback|OutOfMemory|CUDA out of memory|Exception|failed/i.test(l) && !NOISE.test(l))
    .slice(-40)
    .map(({ l }) => l.trim());
  const text = errorsOnly ? matched.join('\n') : tail.join('\n');
  return { path: LOG_PATH, exists: true, size, text, matched, tailLines: arr.length };
}

/** 抓最后一段 Traceback（ComfyUI 出错时日志里最有用的一块） */
export function lastTraceback() {
  const { text } = readLog({ lines: 400 });
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^Traceback \(most recent call last\)/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\[20\d\d-\d\d-\d\d /.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start, end);
  const errLine = block.find((l) => /^[A-Za-z_.]*(Error|Exception):/.test(l.trim()));
  return {
    error_line: errLine ? errLine.trim() : null,
    frames: block.filter((l) => /^\s+File "/.test(l)).slice(-5).map((l) => l.trim()),
    raw: block.slice(-25).join('\n'),
  };
}

/** 把常见异常翻译成可执行的下一步 */
export function explainException(msg = '') {
  const m = String(msg);
  const tips = [];
  if (/out of memory|OutOfMemory|CUDA error: out of memory/i.test(m)) {
    tips.push('显存不够：降分辨率（1024→768）、减 steps、或把 t5 换成 fp8（9.3GB fp16 会挤爆 8GB）。');
  }
  if (/mat1 and mat2 shapes cannot be multiplied/i.test(m)) {
    tips.push('权重与模型结构不匹配：多半是 legacy bnb nf4 权重（0.30.2 不支持），换 GGUF。');
  }
  if (/not found|could not find|No such file/i.test(m)) {
    tips.push('模型文件找不到：用 comfy_models 看本机实际文件名，注意大小写与子目录。');
  }
  if (/Required input is missing|returned no outputs|invalid prompt/i.test(m)) {
    tips.push('工作流本身不合法：先跑 comfy_run(validate_only=true) 让校验器指出具体节点。');
  }
  if (/shape mismatch|cannot reshape|size mismatch/i.test(m)) {
    tips.push('张量形状不匹配：检查 VAE 是否与模型配套（FLUX 必须用 flux-ae），以及 latent 节点是否匹配模型家族。');
  }
  if (/needs a VAE/i.test(m)) {
    tips.push('这个 ControlNet 必须接 VAE：把 VAELoader 接到 ControlNetApplyAdvanced 的 vae 输入（节点定义里标成 optional，但 FLUX controlnet 不带就必炸）。');
  } else if (/ControlNet|control_net/i.test(m)) {
    tips.push('ControlNet 相关：确认 control 图与底图同尺寸、strength 通常 0.5~0.8；过高会压过提示词。');
  }
  return tips;
}
