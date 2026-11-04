#!/usr/bin/env node
// mcp/doctor.mjs — 命令行自检，不依赖任何 MCP 宿主。
//
// 用法：
//   node mcp/doctor.mjs            # 全量（含连 ComfyUI 探模型）
//   node mcp/doctor.mjs --offline  # 不联网：只查配置/Python/目录/权限
//   node mcp/doctor.mjs --json     # 机器可读
//
// 退出码：0 = 没有 fail 项（warn 不影响）；1 = 有 fail 项。
// 先跑它再配 MCP，能省掉「连上了但每张图都失败」的排查时间。
import { runChecks, renderText } from './lib/doctor.mjs';

const args = new Set(process.argv.slice(2));
const offline = args.has('--offline');
const asJson = args.has('--json');

try {
  const r = await runChecks({ skipNetwork: offline });
  process.stdout.write((asJson ? JSON.stringify(r, null, 2) : renderText(r)) + '\n');
  if (!asJson && !r.ok) {
    process.stdout.write('\n还有 fail 项：按上面「修法」逐条处理，再跑一次。\n');
  }
  process.exitCode = r.ok ? 0 : 1;
} catch (e) {
  process.stderr.write(`自检本身崩了：${e.stack || e.message}\n`);
  process.exitCode = 2;
}
