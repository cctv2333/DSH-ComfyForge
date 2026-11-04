// lib/doctor.mjs — 环境自检：给分发出去以后的人看「我这儿到底缺什么」。
//
// 产物是「一组条目」，每条都带 level（ok/warn/fail）+ detail（实测证据）+ fix（怎么修）。
// comfy_health 和 mcp/doctor.mjs 共用同一套检查，避免线上报的和命令行报的不一致。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import {
  BASE, COMFY_ROOT, OUTPUT_DIR, LOG_PATH, PYTHON, MODE, CACHE_DIR, PROJECT_ROOT,
  describe, CONFIG_PATH,
} from './config.mjs';
import { get, systemStats } from './comfy.mjs';
import { probePython } from './img.mjs';
import { capabilityReport, renderCapabilities } from './capabilities.mjs';

const MODEL_EXT = /\.(safetensors|gguf|ckpt|pt|pth|bin)$/i;

/** 从工作流 JSON 里捞出所有「像模型文件名」的输入值 */
export function referencedModels(workflow) {
  const out = new Set();
  for (const node of Object.values(workflow || {})) {
    for (const v of Object.values(node?.inputs || {})) {
      if (typeof v === 'string' && MODEL_EXT.test(v)) out.add(v);
    }
  }
  return [...out];
}

/** object_info 里出现过的所有模型文件名（combo 选项的并集） */
export function knownModelFiles(info) {
  const files = new Set();
  for (const def of Object.values(info || {})) {
    for (const group of [def?.input?.required, def?.input?.optional]) {
      for (const spec of Object.values(group || {})) {
        const opts = Array.isArray(spec?.[0]) ? spec[0] : null;
        if (!opts) continue;
        for (const o of opts) if (typeof o === 'string' && MODEL_EXT.test(o)) files.add(o);
      }
    }
  }
  return files;
}

function dirStats(dir) {
  if (!dir || !existsSync(dir)) return { exists: false };
  try {
    // 只数一层：产物目录通常是 output/<子目录>/x.png，子目录里的图由 runs 记录覆盖，不必递归扫
    const entries = readdirSync(dir, { withFileTypes: true });
    const images = entries.filter((e) => e.isFile() && /\.(png|jpe?g|webp)$/i.test(e.name)).length;
    const subdirs = entries.filter((e) => e.isDirectory()).length;
    return { exists: true, images, subdirs };
  } catch (e) {
    return { exists: true, error: e.message };
  }
}

async function checkComfy() {
  try {
    const s = await systemStats();
    const d = s.devices?.[0] || {};
    return {
      level: 'ok',
      detail: `ComfyUI ${s.system?.comfyui_version || '?'} · ${d.name || '?'} · 显存空闲 ${(Number(d.vram_free || 0) / 1073741824).toFixed(1)}GB`,
      data: { version: s.system?.comfyui_version, gpu: d.name, vram_free_gb: +(Number(d.vram_free || 0) / 1073741824).toFixed(2) },
    };
  } catch (e) {
    return {
      level: 'fail',
      detail: e.message,
      fix: `先启动 ComfyUI（监听到 ${BASE} 才算通）。如果 ComfyUI 在别的机器/端口：设 COMFY_URL=http://host:8188，或在 ${CONFIG_PATH} 里写 {"comfyUrl": "..."}。`,
    };
  }
}

async function checkModels(info = null) {
  if (!info) {
    try { info = await get('/object_info', 90_000); } catch { return null; }
  }
  const known = knownModelFiles(info);
  const tplDir = join(PROJECT_ROOT, 'workflows');
  if (!existsSync(tplDir)) return null;
  const problems = [];
  for (const f of readdirSync(tplDir).filter((x) => x.endsWith('.json'))) {
    let tpl;
    try { tpl = JSON.parse(readFileSync(join(tplDir, f), 'utf8')); } catch { continue; }
    const wf = tpl.workflow || tpl;
    const missing = referencedModels(wf).filter((m) => !known.has(m));
    if (missing.length) problems.push({ template: f.replace(/\.json$/, ''), missing });
  }
  if (!problems.length) return { level: 'ok', detail: `模板引用的模型文件本机都能看到（共识别 ${known.size} 个模型文件）` };
  return {
    level: 'warn',
    detail: problems.map((p) => `${p.template}: 缺 ${p.missing.join(', ')}`).join('；'),
    fix: '这些模板会提交失败。把模型放进 ComfyUI/models/ 对应子目录，或改模板里的模型名。',
  };
}

function checkPython() {
  const r = probePython();
  if (r.ok) return { level: 'ok', detail: `${r.exe} · Python ${r.version}（Pillow+numpy 可用）` };
  return {
    level: 'fail',
    detail: `${r.exe || '未找到'} → ${r.error}`,
    fix: '图像指标/拼图/局部蒙版都依赖它。装一个带 Pillow+numpy 的 Python，然后设 COMFYFORGE_PY 指到 python.exe；' +
      'ComfyUI 便携包自带的 <ComfyUI>/../python/python.exe 通常就用。',
  };
}

function checkCacheWritable() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const probe = join(CACHE_DIR, `.write-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return { level: 'ok', detail: CACHE_DIR };
  } catch (e) {
    return { level: 'fail', detail: `${CACHE_DIR} 不可写：${e.message}`, fix: '检查仓库目录权限，或把仓库放到可写位置。' };
  }
}

/**
 * 全套自检。
 * @param {{skipNetwork?: boolean, skipPython?: boolean}} opts
 */
export async function runChecks({ skipNetwork = false, skipPython = false } = {}) {
  const cfg = describe();
  const checks = [];

  checks.push({
    id: 'config',
    title: '配置文件',
    level: cfg.config_file.error ? 'fail' : 'ok',
    detail: cfg.config_file.exists
      ? `${cfg.config_file.path}${cfg.config_file.error ? '：' + cfg.config_file.error : ''}`
      : `未使用（可选，路径 ${cfg.config_file.path}）`,
    fix: cfg.config_file.error ? 'JSON 写坏了，修好或删掉它退回环境变量/自动探测。' : undefined,
  });

  checks.push({
    id: 'mode',
    title: '运行模式',
    level: MODE === 'local' ? 'ok' : 'warn',
    detail: MODE === 'local'
      ? `local：ComfyUI 在本机 ${COMFY_ROOT}`
      : 'remote：没找到 ComfyUI 安装目录，只能走 HTTP（产物经 /view 下载；读不到 comfyui.log 和本地原图）',
    fix: MODE === 'local' ? undefined
      : '若本机装了 ComfyUI，设 COMFY_ROOT 指到含 main.py 的那层目录，可以省掉下载并启用日志诊断。',
  });

  if (!skipNetwork) {
    const c = await checkComfy();
    checks.push({ id: 'comfyui', title: 'ComfyUI 连通', ...c });
  }

  const out = dirStats(OUTPUT_DIR);
  checks.push({
    id: 'output',
    title: '产物目录',
    level: out.exists ? 'ok' : 'warn',
    detail: out.exists
      ? `${OUTPUT_DIR}（顶层 ${out.images ?? 0} 张图 / ${out.subdirs ?? 0} 个子目录）`
      : `未找到（${OUTPUT_DIR || '未配置'}）`,
    fix: out.exists ? undefined : '设 COMFY_OUTPUT_DIR，或设 COMFY_ROOT 让程序自己推出来。',
  });

  checks.push({
    id: 'log',
    title: 'ComfyUI 日志',
    level: LOG_PATH && existsSync(LOG_PATH) ? 'ok' : 'warn',
    detail: LOG_PATH && existsSync(LOG_PATH) ? `${LOG_PATH}（${(statSync(LOG_PATH).size / 1024).toFixed(0)}KB）` : '读不到（comfy_log 会失效）',
    fix: LOG_PATH && existsSync(LOG_PATH) ? undefined : '设 COMFY_LOG 指到 comfyui.log；远程模式下忽略此项。',
  });

  if (!skipPython) checks.push({ id: 'python', title: 'Python（Pillow+numpy）', ...checkPython() });
  checks.push({ id: 'cache', title: '缓存目录可写', ...checkCacheWritable() });

  let info = null;
  if (!skipNetwork) {
    try { info = await get('/object_info', 90_000); } catch { /* ComfyUI 没连上：能力清单仍按文件系统给 */ }
    const m = await checkModels(info);
    if (m) checks.push({ id: 'models', title: '模板所需模型', ...m });
  }
  // 能力清单：不联网也给（按 custom_nodes / models 目录判），联网时更准（还能看节点）
  const caps = capabilityReport(info);

  const fail = checks.filter((c) => c.level === 'fail').length;
  const warn = checks.filter((c) => c.level === 'warn').length;
  return {
    ok: fail === 0,
    mode: MODE,
    summary: { fail, warn, total: checks.length },
    checks,
    capabilities: caps,
    config: cfg,
    paths: { comfy_root: COMFY_ROOT, output: OUTPUT_DIR, log: LOG_PATH, python: PYTHON, cache: CACHE_DIR, base: BASE },
  };
}

/** 终端里看的文本版（doctor 用） */
export function renderText(result) {
  const mark = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]' };
  const lines = [
    `ComfyForge 自检 · ${result.mode} 模式 · ${result.summary.fail} 失败 / ${result.summary.warn} 警告 / 共 ${result.summary.total} 项`,
    '',
  ];
  for (const c of result.checks) {
    lines.push(`${mark[c.level]} ${c.title}：${c.detail}`);
    if (c.level !== 'ok' && c.fix) lines.push(`       修法：${c.fix}`);
  }
  lines.push('', '配置解析：');
  for (const f of result.config.fields) {
    const src = { env: '环境变量', file: '配置文件', auto: '自动探测', default: '默认值', missing: '未设置', invalid: '不合法' }[f.source] || f.source;
    lines.push(`  ${f.name.padEnd(12)} ${String(f.value).padEnd(46)} [${src}]${f.note ? ' ' + f.note : ''}`);
  }
  if (result.config.config_file.error) lines.push(`  配置文件错误：${result.config.config_file.error}`);
  if (result.capabilities) {
    lines.push('', renderCapabilities(result.capabilities));
  }
  return lines.join('\n');
}
