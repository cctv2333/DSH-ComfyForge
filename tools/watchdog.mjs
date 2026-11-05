#!/usr/bin/env node
// tools/watchdog.mjs —— ComfyUI 存活看门狗：**只看、只报，不杀也不拉起**
//
// 为什么不做"自动重启"：
//   这个工具跑在别人的机器上。它能拿到的是 HTTP，不是进程控制权。
//   贸然 kill/拉起会打断正在跑的任务、也可能拉起错误的环境（用户的 ComfyUI 可能是启动器托管的）。
//   所以这里只做三件事：发现失联、记录时长、给出人可以直接复制的下一步命令。
//
// 用法：
//   node tools/watchdog.mjs                 # 常驻，默认每 30s 探一次
//   node tools/watchdog.mjs --once          # 只探一次（给测试/CI 用）
//   node tools/watchdog.mjs --interval 15 --stall 300 --json
//
// 判据（全部来自 ComfyUI 自己的接口，不猜）：
//   /system_stats  连不上 → 失联；vram_free 极低 → 预警
//   /queue         running 长时间不变且 pending>0 → 疑似卡住（只提示，不干预）
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (n) => process.argv.includes(`--${n}`);

const BASE = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');
const INTERVAL_S = Number(arg('interval', '30'));
const STALL_S = Number(arg('stall', '600'));
const VRAM_WARN_GB = Number(arg('vram-warn', '0.35'));
const ONCE = has('once');
const JSON_OUT = has('json');
const LOG = join(process.cwd(), '.cache', 'watchdog.log');

function log(line) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const msg = `[${ts}] ${line}`;
  if (!JSON_OUT) console.log(msg);
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, msg + '\n', 'utf8');
  } catch { /* 日志写不了不该让看门狗挂掉 */ }
}

async function probe() {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { up: false, error: `HTTP ${r.status}`, ms: Date.now() - t0 };
    const j = await r.json();
    const dev = (j.devices || [])[0] || {};
    const vramFreeGb = dev.vram_free ? +(dev.vram_free / 1024 ** 3).toFixed(2) : null;
    const q = await (await fetch(`${BASE}/queue`, { signal: AbortSignal.timeout(8000) })).json();
    return {
      up: true,
      ms: Date.now() - t0,
      vramFreeGb,
      running: (q.queue_running || []).length,
      pending: (q.queue_pending || []).length,
      version: j.system?.comfyui_version || null,
    };
  } catch (e) {
    return { up: false, error: String(e?.cause?.code || e?.name || e?.message || e), ms: Date.now() - t0 };
  }
}

const HINT = `下一步（人来做）：
  1) 看 ComfyUI 控制台/日志最后几行：<COMFY_ROOT>/user/comfyui.log
  2) 若是显存问题：重启 ComfyUI 后**串行**跑（8GB 下连发会碎片化）
  3) 若是被启动器托管的进程：用启动器重启，别直接 kill`;

async function main() {
  let prev = null;          // 上一次是否 up
  let downSince = null;
  let lastRunning = -1;
  let runningSince = Date.now();

  const tick = async () => {
    const p = await probe();
    const now = Date.now();

    if (!p.up) {
      if (prev !== false) {
        downSince = now;
        log(`✗ ComfyUI 失联（${p.error}，探测耗时 ${p.ms}ms）`);
        if (!JSON_OUT) log(HINT);
      } else {
        log(`  …仍失联（已 ${Math.round((now - downSince) / 1000)}s，${p.error}）`);
      }
      prev = false;
      return p;
    }

    if (prev === false) {
      log(`✓ ComfyUI 恢复（中断 ${Math.round((now - (downSince || now)) / 1000)}s）`);
      downSince = null;
    } else if (prev === null) {
      log(`✓ ComfyUI 在线（${BASE} · 版本 ${p.version || '?'} · 探测 ${p.ms}ms）`);
    }
    prev = true;

    if (p.vramFreeGb != null && p.vramFreeGb < VRAM_WARN_GB) {
      log(`⚠ 显存余量 ${p.vramFreeGb}GB（< ${VRAM_WARN_GB}GB），接近 OOM`);
    }

    // 卡住判定：running 数量长时间不变且还有 pending
    if (p.running !== lastRunning || p.pending === 0) {
      lastRunning = p.running;
      runningSince = now;
    } else if (p.pending > 0 && (now - runningSince) / 1000 > STALL_S) {
      log(`⚠ 疑似卡住：running=${p.running} 已 ${Math.round((now - runningSince) / 1000)}s 未变，pending=${p.pending}`);
    }
    return p;
  };

  const first = await tick();
  if (JSON_OUT) console.log(JSON.stringify({ at: new Date().toISOString(), ok: first.up, ...first }, null, 2));
  if (ONCE) return first.up ? 0 : 1;

  process.on('SIGINT', () => { log('看门狗退出（SIGINT）'); process.exit(0); });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
    await tick();
  }
}

main().then((code) => { if (typeof code === 'number') process.exit(code); }).catch((e) => {
  console.error('看门狗自身出错：', e?.message || e);
  process.exit(2);
});
