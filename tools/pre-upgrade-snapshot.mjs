#!/usr/bin/env node
// pre-upgrade-snapshot.mjs — 升级 ComfyUI 之前，把"现在是什么状态"完整留档。
//
// 为什么需要它：
//   * ComfyUI 本体是 git 仓库，但 custom_nodes 里一半不是（zip 装的），升级后没有回退路径；
//   * pip 环境会被 requirements 带着一起升（torch / av / frontend-package）；
//   * 工作流和模型路径在 user/ 和 models/ 下，不在 git 里。
//   升级失败时，最有用的是"升级前的准确清单"，而不是凭记忆。
//
// 用法: node tools/pre-upgrade-snapshot.mjs --root <ComfyUI 便携包根目录> [--out <备份目录>]
//
// 两个路径都必须由使用者给（或用环境变量），代码里不写死任何一台机器的目录：
//   COMFY_ROOT   ComfyUI 便携包根目录（含 ComfyUI/、python/、git/ 的那一层）
//   BACKUP_DIR   备份落点，默认 <仓库>/backups

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const REPO = path.resolve(HERE, '..');

const ROOT = argOf('--root', process.env.COMFY_ROOT || '');
const OUT_BASE = argOf('--out', process.env.BACKUP_DIR || path.join(REPO, 'backups'));
if (!ROOT) {
  console.error('缺少 ComfyUI 根目录。用法：node tools/pre-upgrade-snapshot.mjs --root "D:\\ComfyUI" [--out ...]');
  console.error('（或设置环境变量 COMFY_ROOT）');
  process.exit(2);
}
const GIT = path.join(ROOT, 'git', 'cmd', 'git.exe');
const PY = path.join(ROOT, 'python', 'python.exe');
const COMFY = path.join(ROOT, 'ComfyUI');
const CN = path.join(COMFY, 'custom_nodes');

const _d = new Date();
const _p = (n) => String(n).padStart(2, '0');
const stamp = `${_d.getFullYear()}${_p(_d.getMonth() + 1)}${_p(_d.getDate())}-${_p(_d.getHours())}${_p(_d.getMinutes())}`;
const OUT = path.join(OUT_BASE, `upgrade-${stamp}`);

function run(cmd, cmdArgs, cwd) {
  try {
    return execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8', timeout: 120000, windowsHide: true }).trim();
  } catch (e) {
    return `__ERR__ ${e.stderr ? String(e.stderr).trim().slice(0, 300) : e.message}`;
  }
}

function sha1File(p) {
  try {
    const buf = fs.readFileSync(p);
    // 只做"是否变化"的指纹，用大小+首尾片段足够，避免引入 crypto 依赖差异
    return `${buf.length}:${buf.subarray(0, 64).toString('hex').slice(0, 16)}`;
  } catch {
    return null;
  }
}

fs.mkdirSync(OUT, { recursive: true });

// ---- 1. ComfyUI 本体 ----
const comfy = {
  root: ROOT,
  comfyPath: COMFY,
  version: (() => {
    try {
      const m = fs.readFileSync(path.join(COMFY, 'comfyui_version.py'), 'utf8').match(/__version__\s*=\s*"([^"]+)"/);
      return m ? m[1] : null;
    } catch { return null; }
  })(),
  gitHead: run(GIT, ['-C', COMFY, 'rev-parse', 'HEAD']),
  gitHeadShort: run(GIT, ['-C', COMFY, 'log', '-1', '--oneline']),
  branch: run(GIT, ['-C', COMFY, 'rev-parse', '--abbrev-ref', 'HEAD']),
  remote: run(GIT, ['-C', COMFY, 'remote', 'get-url', 'origin']),
  status: run(GIT, ['-C', COMFY, 'status', '--porcelain']),
  describe: run(GIT, ['-C', COMFY, 'describe', '--tags', '--always']),
};
fs.writeFileSync(path.join(OUT, 'comfyui.json'), JSON.stringify(comfy, null, 2), 'utf8');

// ---- 2. Python 环境 ----
const freeze = run(PY, ['-m', 'pip', 'freeze']);
fs.writeFileSync(path.join(OUT, 'pip-freeze.txt'), freeze, 'utf8');
const pyVersion = run(PY, ['-c', 'import sys, torch; print(sys.version.split()[0]); print(torch.__version__)']);

// ---- 3. custom_nodes 清单 ----
function dirSizeMB(p) {
  let acc = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const q = path.join(dir, e.name);
      try {
        if (e.isDirectory()) { if (e.name !== '.git') walk(q); } else acc += fs.statSync(q).size;
      } catch { /* ignore */ }
    }
  };
  walk(p);
  return (acc / 1048576).toFixed(1);
}

const packs = [];
if (fs.existsSync(CN)) {
  for (const name of fs.readdirSync(CN)) {
    const dir = path.join(CN, name);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory() || name === '__pycache__') continue;
    const isGit = fs.existsSync(path.join(dir, '.git'));
    const req = path.join(dir, 'requirements.txt');
    const init = path.join(dir, '__init__.py');
    packs.push({
      name,
      sizeMB: dirSizeMB(dir),
      git: isGit,
      gitHead: isGit ? run(GIT, ['-C', dir, 'log', '-1', '--oneline']) : null,
      gitRemote: isGit ? run(GIT, ['-C', dir, 'remote', 'get-url', 'origin']) : null,
      gitDirty: isGit ? (run(GIT, ['-C', dir, 'status', '--porcelain']) || '(clean)') : null,
      hasRequirements: fs.existsSync(req),
      requirementsFingerprint: fs.existsSync(req) ? sha1File(req) : null,
      hasInit: fs.existsSync(init),
    });
  }
}
fs.writeFileSync(path.join(OUT, 'custom_nodes.json'), JSON.stringify(packs, null, 2), 'utf8');

// ---- 4. 工作流（user 目录不在 git 里，必须单独备份）----
const wfDir = path.join(COMFY, 'user', 'default', 'workflows');
let wfCount = 0;
if (fs.existsSync(wfDir)) {
  const dst = path.join(OUT, 'workflows');
  fs.mkdirSync(dst, { recursive: true });
  const copy = (src, rel = '') => {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const p = path.join(src, e.name);
      const r = path.join(rel, e.name);
      if (e.isDirectory()) copy(p, r);
      else if (e.name.endsWith('.json')) {
        fs.mkdirSync(path.dirname(path.join(dst, r)), { recursive: true });
        fs.copyFileSync(p, path.join(dst, r));
        wfCount++;
      }
    }
  };
  copy(wfDir);
}

// ---- 5. ComfyForge 自身 ----
const project = {
  root: REPO,
  packageVersion: (() => {
    try { return JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version; } catch { return null; }
  })(),
  modelsJsonFingerprint: sha1File(path.join(REPO, 'models.json')),
  templates: fs.existsSync(path.join(REPO, 'workflows')) ? fs.readdirSync(path.join(REPO, 'workflows')).filter((f) => f.endsWith('.json')) : [],
};
fs.writeFileSync(path.join(OUT, 'comfyforge.json'), JSON.stringify(project, null, 2), 'utf8');

// ---- 6. 汇总 ----
const nonGit = packs.filter((p) => !p.git).map((p) => p.name);
const withReq = packs.filter((p) => p.hasRequirements).map((p) => p.name);
const summary = {
  snapshot: OUT,
  comfyVersion: comfy.version,
  comfyHead: comfy.gitHeadShort,
  comfyDirty: comfy.status ? comfy.status.split('\n').length : 0,
  python: pyVersion.split('\n')[0],
  torch: pyVersion.split('\n')[1] || null,
  packs: packs.length,
  nonGitPacks: nonGit,
  packsWithRequirements: withReq,
  workflowsBackedUp: wfCount,
};
fs.writeFileSync(path.join(OUT, 'SUMMARY.json'), JSON.stringify(summary, null, 2), 'utf8');

console.log(JSON.stringify(summary, null, 2));
console.log(`\n快照目录：${OUT}`);
console.log('回退时需要的：comfyui.json（git 位置）+ custom_nodes.json（包版本）+ pip-freeze.txt（环境）');
