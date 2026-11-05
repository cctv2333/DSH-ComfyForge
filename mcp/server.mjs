#!/usr/bin/env node
// server.mjs —— 薄装配层：建 server / 注册各域工具 / 连传输。
//
// 为什么拆：docs/TOOL-AUDIT.md 的 P0 —— 单文件 2000 行同时承载 33 个工具注册与全部 payload 构造，
// 改一处要在大文件里跳来跳去。拆分是**机械搬移**，逻辑一行没改；回归靠 mcp/test/selftest.mjs。
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { extname, join, dirname, basename, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  BASE, OUTPUT_DIR, WORKFLOW_DIR, RUNS_DIR, COMFY_ROOT, PROJECT_ROOT, LOG_PATH, MODE, ComfyError,
  systemStats, queueState, historyResolved, recentHistory, objectInfo, submit, waitFor,
  parseHistoryEntry, interrupt, deleteFromQueue, localOutputPath, sleep, POLL_MS, NOT_QUEUED_GRACE_MS,
} from './lib/comfy.mjs';
import { metrics as imgMetrics, makeSheet, materialize, previewFor } from './lib/img.mjs';
import {
  getTemplate, listTemplates, saveTemplate, deleteTemplate,
  resolveTemplate, validateWorkflow, saveRun, listRuns, ensureDirs,
} from './lib/templates.mjs';
import { readLog, lastTraceback, explainException } from './lib/diag.mjs';
import { rememberRun, rememberLesson, recallLessons, stats as memoryStats, setPending, takePending } from './lib/memory.mjs';
import { checkSize, modelFromWorkflow, listProfiles, profileFor, loadRegistry, saveRegistry } from './lib/models.mjs';
import { addPick, removePick, listPicks, clearPicks, keyOf } from './lib/picks.mjs';
import { uploadImage, makeMask, diffImages, compositeImages, placePrep, edgeControl, keyMask } from './lib/edit.mjs';
import { lookAt, regionOf } from './lib/view.mjs';
import { scan as triageScan, apply as triageApply, restore as triageRestore, resolveDir } from './lib/triage.mjs';
import { append as journalAppend, list as journalList, search as journalSearch, paths as journalPaths } from './lib/journal.mjs';
import { runChecks } from './lib/doctor.mjs';
import { auditModels } from './lib/modelfiles.mjs';
import {
  listWorkflows, inspectWorkflow, installedPacks, classifyNodes, renderWorkflowDoc, writeDoc, workflowDir,
} from './lib/workflows.mjs';
import { checkWorkflows, formatReport } from './lib/workflowcheck.mjs';
import { startVideo, videoStatus, framesFor, extractFrames, makeVideoSheet, videoMetrics } from './lib/video.mjs';
import { lintPrompt, lintWithLLM, readPromptFile } from './lib/promptlint.mjs';
import * as C from './tools/ctx.mjs';

import './tools/system.mjs';
import './tools/generate.mjs';
import './tools/view.mjs';
import './tools/edit.mjs';
import './tools/library.mjs';
import './tools/media.mjs';

const { server } = C;


// ---------------------------------------------------------------- misc

// 启动横幅（走 stderr，不污染 stdio 的 JSON-RPC）：
// 分发给别人以后，「配置没对」要在客户端日志里就能看见，不必先撞一次失败。
try {
  const { describe } = await import('./lib/config.mjs');
  const d = describe();
  const notes = [];
  if (d.config_file.error) notes.push(`配置文件有问题：${d.config_file.error}`);
  if (d.mode === 'remote') notes.push('未找到 ComfyUI 安装目录 → remote 模式（只走 HTTP，读不到日志/本地原图）。设 COMFY_ROOT 可切换。');
  for (const name of d.missing) {
    if (name === 'outputDir' || name === 'comfyRoot') notes.push(`缺配置${name}（看最新图/淘汰/看板会不可用）`);
  }
  if (notes.length) {
    process.stderr.write(`[comfy-forge] 环境提示：\n  - ${notes.join('\n  - ')}\n 自查：node mcp/doctor.mjs\n`);
  }
} catch (e) {
  process.stderr.write(`[comfy-forge] 配置自检失败（不影响启动）：${e.message}\n`);
}

const transport = new StdioServerTransport();
await server.connect(transport);

// 不让未捕获异常静默杀死服务：打到 stderr，客户端仍能拿到错误响应
process.on('unhandledRejection', (e) => {
  process.stderr.write(`[comfy-forge] unhandledRejection: ${e?.stack || e}\n`);
});
process.on('uncaughtException', (e) => {
  process.stderr.write(`[comfy-forge] uncaughtException: ${e?.stack || e}\n`);
});

