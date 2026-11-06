// tools/capacity.mjs — 开跑之前先算账：这台机器现在到底跑不跑得动
//
// 为什么要有它：2026-11-06 有一次 15 秒二采跑了 3 小时 20 分，中间还 OOM 两次。
// 事后看日志，根因不是"模型慢"，是**内存不够**：
//   H3 的 int8 权重 19.53GB + 文本编码器 25.28GB，而本机内存只有 14.9GB。
//   ComfyUI 用 fast_disk 把它们从磁盘反复 stage 进显存，
//   每个分块边界重读 20GB；commit 见底时直接 OOM。
// 判据全部来自实测，不是拍脑袋：
//   OOM 现场（comfyui.prev2.log 01:43）：Requested 17.76GiB / Device limit 7.93GiB
//   成功那次（23:31）：一采 65 分钟、二采 3 块 135 分钟。
//
// 用法：
//   node tools/capacity.mjs                    # 按最重的 H3 二采判
//   node tools/capacity.mjs --for image        # 只出图
//   node tools/capacity.mjs --for h3-1pass --seconds 5
//   node tools/capacity.mjs --json             # 给脚本用
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);

const KIND = arg('for', 'h3-2pass');
const SECONDS = Number(arg('seconds', 15));
const CHUNK = Number(arg('chunk', 153));
const OVERLAP = Number(arg('overlap', 17));
const FPS = 24;

// 权重体积（读不到就用实测值兜底；这些是 2026-11-06 的实测 stage 值）
const WEIGHTS = {
  'h3-unet': 19_995,          // MB，日志 "MiniMaxH3 ... 19995MB Staged"
  'h3-text-encoder': 25_882,  // MB，qwen3vl_32b_minimax_h3_int8_convrot
  'h3-video-vae': 4_965,
  'h3-audio-vae': 576,
  'image-unet': 7_200,        // MOSS/Krea2 量级
  'image-te': 7_100,
};

const PROFILES = {
  'h3-2pass': {
    label: 'H3 二采（r2v 一采 → 3D 放大 → 分块重采样）',
    weights: ['h3-unet', 'h3-text-encoder', 'h3-video-vae', 'h3-audio-vae'],
    // 峰值 commit：权重要能被 staged + 激活 + VAE 解码
    minCommitGB: 26,
    minRamFreeGB: 4,
    minVramFreeGB: 1.5,
    // 实测基线：一采 362 帧 65 分钟 → 0.18 分/帧；二采每块约 45 分钟
    estimate: (s) => {
      const frames = Math.ceil(s * FPS / 17) * 17 + 5;
      const chunks = frames <= CHUNK ? 1 : 1 + Math.ceil((frames - CHUNK) / (CHUNK - OVERLAP));
      return { frames, chunks, minutes: Math.round(frames * 0.18 + chunks * 45) };
    },
  },
  'h3-1pass': {
    label: 'H3 单遍（i2v，无放大二采）',
    weights: ['h3-unet', 'h3-text-encoder', 'h3-video-vae', 'h3-audio-vae'],
    minCommitGB: 26,
    minRamFreeGB: 4,
    minVramFreeGB: 1.5,
    estimate: (s) => {
      const frames = Math.ceil(s * FPS / 17) * 17 + 5;
      return { frames, chunks: 0, minutes: Math.round(frames * 0.18) };
    },
  },
  image: {
    label: '出图（MOSS / Krea2 / FLUX.2）',
    weights: ['image-unet', 'image-te'],
    minCommitGB: 14,
    minRamFreeGB: 2.5,
    minVramFreeGB: 1.5,
    estimate: () => ({ frames: 0, chunks: 0, minutes: 1 }),
  },
};

const profile = PROFILES[KIND];
if (!profile) {
  console.error(`不认识的 --for "${KIND}"，可选：${Object.keys(PROFILES).join(' / ')}`);
  process.exit(2);
}

/** 提交上限与剩余 virtual（Windows 才有意义） */
function commitInfo() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_OperatingSystem | Select-Object TotalVirtualMemorySize,FreeVirtualMemory | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    const j = JSON.parse(out.trim());
    return { limitGB: j.TotalVirtualMemorySize / 1048576, freeGB: j.FreeVirtualMemory / 1048576 };
  } catch {
    return null;
  }
}

function pagefileInfo() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_PageFileUsage | Select-Object Name,AllocatedBaseSize,CurrentUsage | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    const j = JSON.parse(out.trim());
    return { name: j.Name, allocatedMB: j.AllocatedBaseSize, usedMB: j.CurrentUsage };
  } catch {
    return null;
  }
}

async function comfyInfo() {
  try {
    const s = await (await fetch('http://127.0.0.1:8188/system_stats', { signal: AbortSignal.timeout(6000) })).json();
    const d = s.devices?.[0] || {};
    const q = await (await fetch('http://127.0.0.1:8188/queue', { signal: AbortSignal.timeout(6000) })).json();
    return {
      version: s.system?.comfyui_version,
      vramTotalGB: (d.vram_total || 0) / 1073741824,
      vramFreeGB: (d.vram_free || 0) / 1073741824,
      running: (q.queue_running || []).length,
      pending: (q.queue_pending || []).length,
    };
  } catch {
    return null;
  }
}

const ramTotalGB = os.totalmem() / 1073741824;
const ramFreeGB = os.freemem() / 1073741824;
const commit = commitInfo();
const pagefile = pagefileInfo();
const comfy = await comfyInfo();

const weightMB = profile.weights.reduce((s, k) => s + WEIGHTS[k], 0);
const est = profile.estimate(SECONDS);

const rows = [
  { name: '物理内存空闲', have: `${ramFreeGB.toFixed(1)} / ${ramTotalGB.toFixed(1)} GB`, need: `≥ ${profile.minRamFreeGB} GB`, ok: ramFreeGB >= profile.minRamFreeGB },
  {
    name: 'Commit 剩余',
    have: commit ? `${commit.freeGB.toFixed(1)} / ${commit.limitGB.toFixed(1)} GB` : '未知',
    need: `≥ ${profile.minCommitGB} GB`,
    ok: commit ? commit.freeGB >= profile.minCommitGB : null,
  },
  {
    name: '显存空闲',
    have: comfy ? `${comfy.vramFreeGB.toFixed(2)} / ${comfy.vramTotalGB.toFixed(2)} GB` : '连不上 ComfyUI',
    need: `≥ ${profile.minVramFreeGB} GB`,
    ok: comfy ? comfy.vramFreeGB >= profile.minVramFreeGB : false,
  },
  {
    name: '权重 / Commit 剩余',
    have: commit ? `${(weightMB / 1024).toFixed(1)} / ${commit.freeGB.toFixed(1)} GB` : `${(weightMB / 1024).toFixed(1)} GB / 未知`,
    need: `权重 ≤ 剩余`,
    ok: commit ? commit.freeGB * 1024 >= weightMB : null,
  },
];

const red = rows.filter((r) => r.ok === false);
const warn = rows.filter((r) => r.ok === null);
const verdict = red.length ? 'red' : warn.length ? 'warn' : 'green';

if (has('json')) {
  console.log(JSON.stringify({
    kind: KIND, verdict, seconds: SECONDS, estimate: est, weightsGB: +(weightMB / 1024).toFixed(1),
    ram: { totalGB: +ramTotalGB.toFixed(1), freeGB: +ramFreeGB.toFixed(1) },
    commit, pagefile, comfy, rows,
  }, null, 2));
  process.exit(verdict === 'red' ? 2 : 0);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n体检：${profile.label}`);
console.log(`  时长 ${SECONDS}s → ${est.frames} 帧${est.chunks ? ` / ${est.chunks} 个二采块` : ''}`);
console.log(`  权重合计 ${(weightMB / 1024).toFixed(1)} GB（要 staged，不是一次全驻留）\n`);
for (const r of rows) {
  const mark = r.ok === true ? '✓' : r.ok === false ? '✗' : '!';
  console.log(` ${mark}  ${pad(r.name, 22)} 当前 ${pad(r.have, 22)} 需要 ${r.need}`);
}
if (pagefile) console.log(`\n  页面文件 ${pagefile.name} 已分配 ${(pagefile.allocatedMB / 1024).toFixed(1)} GB，已用 ${(pagefile.usedMB / 1024).toFixed(1)} GB`);
if (comfy) console.log(`  ComfyUI ${comfy.version}｜队列 running ${comfy.running} / pending ${comfy.pending}`);

console.log(`\n  预计耗时 ${est.minutes} 分钟（基线：一采 0.18 分/帧、二采 45 分/块，2026-11-06 实测）`);

if (verdict === 'red') {
  console.log('\n结论：**现在别跑**。');
  console.log('  · Commit 见底是最致命的：H3 要一次性实体化 20 GB 权重，不够就直接 OOM。');
  console.log('  · 最有效的解法：**重启 ComfyUI**（把 staged 的权重还回去），再关掉浏览器里不用的标签。');
  console.log('  · 重启后重跑这条命令，直到三项都是 ✓ 再开。');
  process.exit(2);
}
if (verdict === 'warn') {
  console.log('\n结论：能跑，但有一项算不出来（多半是连不上 ComfyUI，先 comfy_health 看一眼）。');
  process.exit(0);
}
console.log('\n结论：可以跑。');
process.exit(0);
