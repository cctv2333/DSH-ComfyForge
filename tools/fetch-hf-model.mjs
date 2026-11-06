// tools/fetch-hf-model.mjs — 从 HF 镜像把一个「完整 HF 模型目录」拉到本地
//
// 为什么需要它：
//   1. huggingface.co 在这台机器上不通，hf-mirror.com 通（实测 ~64MB/s）。
//   2. ComfyUI 的 VRGDG_GeneralVLM 之类节点要的是**完整 HF 目录**
//      （config.json + tokenizer + 权重），不是一个 .safetensors 单文件；
//      而 diffusion 用的那些 int8/fp8 单文件编码器**不能**当聊天 VLM 用。两回事。
//   3. 节点自己的 download_if_missing 走 huggingface_hub → 连不上 → 必须预先落盘。
//
// 落点规则（照抄节点源码 LLM.py:1733-1751）：
//   <ComfyUI>/models/LLM/Qwen/<组织>--<仓库名>/
//   例：Qwen/Qwen3-VL-2B-Instruct → models/LLM/Qwen/Qwen--Qwen3-VL-2B-Instruct
//
// 用法：
//   node tools/fetch-hf-model.mjs --repo Qwen/Qwen3-VL-2B-Instruct
//   node tools/fetch-hf-model.mjs --repo Qwen/Qwen3-VL-2B-Instruct --dest "D:/x" --dry-run
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { COMFY_ROOT } from '../mcp/lib/config.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);

const MIRROR = (arg('mirror', 'https://hf-mirror.com') || '').replace(/\/$/, '');
const REPO = arg('repo');
const DRY = has('dry-run');

if (!REPO) { console.error('需要 --repo <组织/仓库名>'); process.exit(2); }

// 默认落到节点认的位置
const dest = arg('dest') || (COMFY_ROOT
  ? join(COMFY_ROOT, 'models', 'LLM', 'Qwen', REPO.replace(/[/\\:]/g, '--'))
  : null);
if (!dest) { console.error('没有 COMFY_ROOT，必须用 --dest 指定落点'); process.exit(2); }

// 这些对推理没用（.gitattributes 是 LFS 声明，README 是给人看的）
const SKIP = /(^\.gitattributes$|^README\.md$|^\.gitignore$)/;

const apiUrl = `${MIRROR}/api/models/${REPO}`;
const meta = await (await fetch(apiUrl, { signal: AbortSignal.timeout(30_000) })).json();
if (meta.error) { console.error(`镜像返回错误：${meta.error}`); process.exit(2); }
if (meta.gated) { console.error('这个仓库是 gated，需要先在网页上接受协议并提供 token'); process.exit(2); }

const files = (meta.siblings || []).map((s) => s.rfilename).filter((f) => !SKIP.test(f));
console.log(`仓库 ${REPO}${meta.gated ? '（gated）' : ''}，共 ${files.length} 个文件`);
console.log(`落点 ${dest}`);
if (DRY) {
  for (const f of files) console.log('  ' + f);
  // 不用 process.exit：Node 在 Windows 上带着未关的 keep-alive socket 退出会触发
  // libuv 的 assertion（"!(handle->flags & UV_HANDLE_CLOSING)"），退码变 1，看着像失败
  process.exitCode = 0;
} else {
  await downloadAll(files, dest);
}

async function downloadAll(files, dest) {
  mkdirSync(dest, { recursive: true });

  let totalBytes = 0;
  let skipped = 0;
  const failures = [];

  for (const [i, name] of files.entries()) {
    const out = join(dest, name);
    const url = `${MIRROR}/${REPO}/resolve/main/${name}`;
    mkdirSync(dirname(out), { recursive: true });

    // 已经下完就不动：本地大小 == 远端 Content-Length 才算完成
    let remoteLen = 0;
    try {
      const h = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(30_000) });
      remoteLen = Number(h.headers.get('content-length') || 0);
    } catch { /* 拿不到长度就照下 */ }

    if (existsSync(out) && remoteLen && statSync(out).size === remoteLen) {
      console.log(`[${i + 1}/${files.length}] 跳过（已完整）${name}  ${(remoteLen / 1048576).toFixed(1)}MB`);
      skipped++;
      totalBytes += remoteLen;
      continue;
    }
    // 半截文件必须删掉，否则续传会拼坏（吃过这个亏）
    if (existsSync(out) && remoteLen && statSync(out).size !== remoteLen) unlinkSync(out);

    const started = Date.now();
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(3_600_000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(out));
      const size = statSync(out).size;
      if (remoteLen && size !== remoteLen) throw new Error(`大小不符：本地 ${size} / 远端 ${remoteLen}`);
      const sec = Math.max(0.001, (Date.now() - started) / 1000);
      totalBytes += size;
      console.log(`[${i + 1}/${files.length}] ✓ ${name}  ${(size / 1048576).toFixed(1)}MB  ${(size / 1048576 / sec).toFixed(0)}MB/s`);
    } catch (e) {
      // 失败不留半截文件，否则下次会被误判成"已有"
      try { if (existsSync(out)) unlinkSync(out); } catch { /* ignore */ }
      failures.push(`${name}: ${e.message}`);
      console.error(`[${i + 1}/${files.length}] ✗ ${name}  ${e.message}`);
    }
  }

  console.log(`\n完成：${files.length - failures.length}/${files.length} 个文件，共 ${(totalBytes / 1073741824).toFixed(2)}GB` + (skipped ? `（其中 ${skipped} 个已存在）` : ''));
  console.log(`\n模型在：${dest}`);
  console.log(`节点里把 custom_model_id 填：${REPO}`);
  if (failures.length) { console.error('失败：\n  ' + failures.join('\n  ')); process.exitCode = 1; }
}

