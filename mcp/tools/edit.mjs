// tools/edit.mjs —— edit 域的工具注册（从 server.mjs 机械搬移，逻辑未改）
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
} from '../lib/comfy.mjs';
import { metrics as imgMetrics, makeSheet, materialize, previewFor } from '../lib/img.mjs';
import {
  getTemplate, listTemplates, saveTemplate, deleteTemplate,
  resolveTemplate, validateWorkflow, saveRun, listRuns, ensureDirs,
} from '../lib/templates.mjs';
import { readLog, lastTraceback, explainException } from '../lib/diag.mjs';
import { rememberRun, rememberLesson, recallLessons, stats as memoryStats, setPending, takePending } from '../lib/memory.mjs';
import { checkSize, modelFromWorkflow, listProfiles, profileFor, loadRegistry, saveRegistry } from '../lib/models.mjs';
import { addPick, removePick, listPicks, clearPicks, keyOf } from '../lib/picks.mjs';
import { uploadImage, makeMask, diffImages, compositeImages, placePrep, edgeControl, keyMask } from '../lib/edit.mjs';
import { lookAt, regionOf } from '../lib/view.mjs';
import { scan as triageScan, apply as triageApply, restore as triageRestore, resolveDir } from '../lib/triage.mjs';
import { append as journalAppend, list as journalList, search as journalSearch, paths as journalPaths } from '../lib/journal.mjs';
import { runChecks } from '../lib/doctor.mjs';
import { auditModels } from '../lib/modelfiles.mjs';
import {
  listWorkflows, inspectWorkflow, installedPacks, classifyNodes, renderWorkflowDoc, writeDoc, workflowDir,
} from '../lib/workflows.mjs';
import { checkWorkflows, formatReport } from '../lib/workflowcheck.mjs';
import { startVideo, videoStatus, framesFor, extractFrames, makeVideoSheet, videoMetrics } from '../lib/video.mjs';
import { lintPrompt, lintWithLLM, readPromptFile } from '../lib/promptlint.mjs';
import * as C from './ctx.mjs';
// 工具体内用的是裸名，这里把共享上下文给齐
const {
  server, J, text, fail, norm, gb, trimMetrics, inspectImages, resolveWorkflow, preflight,
  latentSize, queuePosition, executionFailure, viewHint, visualPayload, logActivity, submitShape,
  EDIT_DIR, withControl, editWorkflow, finishEdit, pollMany, summarizeEntries, newestOutputs,
} = C;
// 本文件注册 6 个工具：comfy_upload, comfy_edit, comfy_replace, comfy_composite, comfy_place, comfy_restructure

server.tool(
  'comfy_upload',
  '把本地图片上传到 ComfyUI 的 input 目录，返回 LoadImage 能用的文件名。img2img / inpaint 前需要它。',
  {
    path: z.string().describe('本地图片绝对路径'),
    type: z.enum(['input', 'temp']).default('input'),
  },
  async (args) => {
    try {
      const up = await uploadImage(args.path, { type: args.type });
      return text({ ok: true, ...up, local: args.path });
    } catch (e) {
      return fail(`上传失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_edit',
  '局部编辑：给一张图 + 一个矩形/椭圆区域，只重画那块（蒙版外几乎不动）；不给 box 就是整图低 denoise 精修。返回产物和「蒙版内外改动比例」，用来验证是否真的只改了局部。',
  {
    image: z.string().optional().describe('本地图片绝对路径（自动上传），或 input 目录里的文件名；续等时可不传'),
    box: z.array(z.number()).length(4).optional().describe('[x, y, w, h]；给了就是局部重绘，不给就是整图 img2img'),
    mask: z.string().optional().describe('显式蒙版图路径（白色=重画）。比矩形 box 更贴合物体，接缝更小；与 box 二选一'),
    ellipse: z.boolean().default(false).describe('蒙版用椭圆而不是圆角矩形'),
    expand: z.number().int().min(0).max(200).default(10).describe('蒙版向外扩几像素'),
    feather: z.number().int().min(0).max(80).default(14).describe('羽化半径，越大接缝越软'),
    prompt: z.string().optional().describe('只描述「蒙版里应该出现什么」，不要重复整幅画面'),
    negative: z.string().default(''),
    denoise: z.number().min(0.05).max(1).optional().describe('局部 0.65~0.8；整图精修 0.25~0.45；有 control 时用 0.9~1.0'),
    control: z.string().optional().describe('控制图路径（如 C-130 线稿/深度图）。提示词说不清的形状，靠它定；不给就纯提示词'),
    control_strength: z.number().min(0).max(2).default(0.75).describe('控制强度；>0.9 容易复刻画风'),
    control_net: z.string().default('flux-cn-union-pro-2.0.safetensors'),
    steps: z.number().int().min(4).max(60).default(20),
    seed: z.number().int().optional(),
    guidance: z.number().min(0).max(10).default(3.5),
    wait_s: z.number().int().min(0).max(55).default(45),
    prompt_id: z.string().optional().describe('续等上一次编辑（返回 pending 时用。'),
  },
  async (args) => {
    try {
      let ctx;
      if (args.prompt_id) {
        const p = join(EDIT_DIR, `${args.prompt_id}.json`);
        if (!existsSync(p)) return fail(`找不到${args.prompt_id} 的编辑上下文，可能已被清理`);
        ctx = JSON.parse(readFileSync(p, 'utf8'));
      } else {
        if (!args.image) return fail('需要 image（本地绝对路径，或 input 目录里的文件名）');
        if (!args.prompt) return fail('需要 prompt（描述蒙版里应该出现什么）');
        const localSrc = existsSync(args.image)
          ? args.image
          : (COMFY_ROOT ? join(COMFY_ROOT, 'input', args.image) : args.image);
        if (!existsSync(localSrc)) {
          return fail(`找不到图片：${args.image}` + (COMFY_ROOT ? `（也查过 ${join(COMFY_ROOT, 'input')}）`
            : '（remote 模式只认本地绝对路径；没配置 COMFY_ROOT，无法在其 input 目录里找）'));
        }
        const up = await uploadImage(localSrc, { name: `src_${Date.now()}${extname(localSrc) || '.png'}` });

        let mask = null;
        let maskName = null;
        if (args.mask) {
          // 显式蒙版：只重画蒙版里那部分（比矩形框更贴合物体，接缝也小）
          if (!existsSync(args.mask)) return fail(`找不到蒙版：${args.mask}`);
          mask = { path: args.mask };
          const upm = await uploadImage(args.mask, { name: `mask_${Date.now()}.png` });
          maskName = upm.name;
        } else if (args.box) {
          mask = makeMask({
            imagePath: localSrc, box: args.box, ellipse: args.ellipse,
            expand: args.expand, feather: args.feather,
          });
          const upm = await uploadImage(mask.path, { name: `mask_${Date.now()}.png` });
          maskName = upm.name;
        }

        const isInpaint = !!(maskName);
        const tplName = isInpaint ? 'flux_inpaint' : 'flux_img2img';
        const params = {
          image: up.name,
          prompt: args.prompt,
          negative: args.negative,
          denoise: args.denoise ?? (isInpaint ? (args.control ? 0.9 : 0.7) : 0.4),
          steps: args.steps,
          guidance: args.guidance,
          seed: args.seed ?? Math.floor(Math.random() * 2147483647),
          filename_prefix: `comfyforge/${isInpaint ? 'inpaint' : 'img2img'}`,
        };
        if (maskName) params.mask = maskName;

        const tpl = getTemplate(tplName);
        const { workflow: baseWf } = resolveTemplate(tpl, params);
        let workflow = baseWf;

        // 可选控制网：提示词说不清「这是哪种飞机/哪个人/什么姿势」时，用控制图定形状。
        // 做法是在模板末尾接三个节点（20 控制网、21 控制图、22 叠加），再把 KSampler 的 cond 改接到 22。
        let controlInfo = null;
        if (args.control) {
          if (!existsSync(args.control)) return fail(`找不到控制图：${args.control}`);
          const upctrl = await uploadImage(args.control, { name: `ctrl_${Date.now()}.png` });
          workflow = withControl(workflow, { controlName: upctrl.name, strength: args.control_strength, net: args.control_net });
          controlInfo = { path: args.control, strength: args.control_strength, net: args.control_net };
        }

        const v = await preflight(workflow);
        if (v.errors.length) return fail('编辑工作流没通过校验', { errors: v.errors, warnings: v.warnings, hints: v.hints });

        const sub = await submit(workflow);
        ctx = {
          prompt_id: sub.prompt_id, tpl: tplName, params,
          source: localSrc, mask: mask?.path || null, box: args.box || null,
          control: controlInfo,
          created: new Date().toISOString(),
        };
        mkdirSync(EDIT_DIR, { recursive: true });
        writeFileSync(join(EDIT_DIR, `${sub.prompt_id}.json`), JSON.stringify(ctx, null, 2), 'utf8');
      }

      const r = await waitFor(ctx.prompt_id, { timeoutS: args.wait_s });
      if (r.pending) {
        return text({
          ok: true, pending: true, prompt_id: ctx.prompt_id,
          waited_s: Math.round(r.elapsedMs / 100) / 10, queue: r.queue,
          mask: ctx.mask, source: ctx.source,
          next: `还没跑完：comfy_edit(prompt_id="${ctx.prompt_id}") 继续`,
        });
      }
      return await finishEdit(ctx, r.entry);
    } catch (e) {
      return fail(`局部编辑失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_replace',
  '换物体（先擦后画两遍法）：把 box 里的旧东西擦成背景，再用控制图把新物体画进去。适合「把 A 换成 B，其它别动」。比单次 inpaint 稳，因为第一遍不要求画面里有什么。',
  {
    image: z.string().optional().describe('底图本地路径（续等时可不传）'),
    box: z.array(z.number()).length(4).optional().describe('要替换的区域 [x,y,w,h]（第一遍擦除就在这块里）'),
    object: z.string().optional().describe('新物体的参考图（控制图画它，不给就只用提示词）'),
    prompt: z.string().optional().describe('第二遍：描述新物体应该在画面里长什么样'),
    erase_prompt: z.string().default('seamless continuation of the surrounding background, exactly the same brightness, color and texture, no objects'),
    control_strength: z.number().min(0).max(2).default(0.75),
    steps: z.number().int().min(4).max(60).default(20),
    feather: z.number().int().min(0).max(80).default(30).describe('区域的羽化半径；小蒙版会让模型不理会提示词，所以默认给足'),
    wait_s: z.number().int().min(0).max(55).default(50),
    prompt_id: z.string().optional().describe('续等（两遍法要跑两次，返回 pending 时用）'),
  },
  async (args) => {
    try {
      let ctx;
      if (args.prompt_id) {
        const p = join(EDIT_DIR, `${args.prompt_id}.json`);
        if (!existsSync(p)) return fail(`找不到 ${args.prompt_id} 的替换上下文`);
        ctx = JSON.parse(readFileSync(p, 'utf8'));
      } else {
        if (!args.image || !args.box || !args.prompt) return fail('需要 image、box、prompt（续等时只传 prompt_id）');
        const src = existsSync(args.image) ? args.image : (COMFY_ROOT ? join(COMFY_ROOT, 'input', args.image) : args.image);
        if (!existsSync(src)) return fail(`找不到底图：${args.image}`);

        const size = imgMetrics([src])[0];
        const W = size?.width, H = size?.height;
        if (!W || !H) return fail('量不出底图尺寸，无法生成蒙版');

        // 第一遍的蒙版：整块区域（不是物体轮廓——贴着轮廓的蒙版会让模型顺着旧线继续画）
        const eraseMask = makeMask({ imagePath: src, box: args.box, expand: 20, feather: args.feather });
        const upSrc = await uploadImage(src, { name: `replace_src_${Date.now()}${extname(src) || '.png'}` });
        const upMask = await uploadImage(eraseMask.path, { name: `replace_mask_${Date.now()}.png` });

        // 第二遍要用的东西先准备好：控制图 + 蒙版。
        // 蒙版用「区域」而不是物体轮廓：贴着轮廓的蒙版会让模型顺着旧线画（BUG-0022 的实测结论）
        let controlPath = null;
        if (args.object) {
          if (!existsSync(args.object)) return fail(`找不到参考图：${args.object}`);
          controlPath = placePrep({ scene: src, object: args.object, box: args.box, feather: 0, protect: 0 }).control;
        }
        const drawMask = eraseMask.path;

        const { workflow, params, tplName } = editWorkflow({
          imageName: upSrc.name, maskName: upMask.name, prompt: args.erase_prompt,
          denoise: 1.0, steps: args.steps, prefix: 'comfyforge/replace_erase',
        });
        const v = await preflight(workflow);
        if (v.errors.length) return fail('擦除这一步没通过校验', { errors: v.errors, warnings: v.warnings, hints: v.hints });
        const sub = await submit(workflow);
        ctx = {
          prompt_id: sub.prompt_id, stage: 'erase', tpl: tplName, params,
          source: src, box: args.box, object: args.object || null,
          prompt: args.prompt, controlPath, drawMask,
          control_strength: args.control_strength, steps: args.steps,
          created: new Date().toISOString(),
        };
        mkdirSync(EDIT_DIR, { recursive: true });
        writeFileSync(join(EDIT_DIR, `${sub.prompt_id}.json`), JSON.stringify(ctx, null, 2), 'utf8');
        // 第一遍刚提交就返回：两遍生成加起来必然超过客户端 60s 上限，不能在同一次调用里连等
        return text({
          ok: true, pending: true, stage: 'erase', prompt_id: sub.prompt_id,
          next: `comfy_replace(prompt_id="${sub.prompt_id}") 继续（等擦除完成，随后自动画新物体）`,
        });
      }
      {
        const r = await waitFor(ctx.prompt_id, { timeoutS: args.wait_s });
        if (r.pending) {
          return text({
            ok: true, pending: true, stage: ctx.stage, prompt_id: ctx.prompt_id, queue: r.queue,
            next: `comfy_replace(prompt_id="${ctx.prompt_id}") 继续`,
          });
        }
        const parsed = parseHistoryEntry(r.entry);
        if (parsed.status !== 'success') {
          const diag = executionFailure(parsed);
          return fail(`替换失败（${ctx.stage} 阶段）：${diag.exception_message || parsed.status}`, { stage: ctx.stage, diagnosis: diag });
        }

        if (ctx.stage === 'erase') {
          const { rows } = await inspectImages(parsed.images);
          const cleaned = rows.find((x) => x.path)?.path;
          if (!cleaned) return fail('擦除这一步没有产物');
          const up2 = await uploadImage(cleaned, { name: `replace_clean_${Date.now()}.png` });
          const upMask2 = await uploadImage(ctx.drawMask, { name: `replace_mask2_${Date.now()}.png` });
          let upCtrl = null;
          if (ctx.controlPath) upCtrl = await uploadImage(ctx.controlPath, { name: `replace_ctrl_${Date.now()}.png` });

          const draw = editWorkflow({
            imageName: up2.name, maskName: upMask2.name, prompt: ctx.prompt,
            denoise: 1.0, steps: ctx.steps, prefix: 'comfyforge/replace_draw',
            controlName: upCtrl?.name || null, controlStrength: ctx.control_strength,
          });
          const v2 = await preflight(draw.workflow);
          if (v2.errors.length) return fail('画物体这一步没通过校验', { errors: v2.errors, warnings: v2.warnings, hints: v2.hints });
          const sub2 = await submit(draw.workflow);
          ctx = {
            ...ctx, stage: 'draw', prompt_id: sub2.prompt_id,
            params: draw.params, tpl: draw.tplName, erased: cleaned,
          };
          writeFileSync(join(EDIT_DIR, `${sub2.prompt_id}.json`), JSON.stringify(ctx, null, 2), 'utf8');
          return text({
            ok: true, pending: true, stage: 'draw', prompt_id: sub2.prompt_id, erased: cleaned,
            next: `comfy_replace(prompt_id="${sub2.prompt_id}") 继续（等新物体画完）`,
          });
        }

        // stage = draw：出结果
        const { rows } = await inspectImages(parsed.images);
        const payload = {
          ok: true, stage: 'done', prompt_id: ctx.prompt_id,
          source: ctx.source, erased: ctx.erased, box: ctx.box,
          control: ctx.controlPath, prompt: ctx.prompt,
          outputs: rows.map((x) => ({ path: x.path, quality: x.metrics ? trimMetrics(x.metrics) : null })),
          note: '两遍法：第一遍把区域擦成背景，第二遍用控制图画新物体。若新物体没有出现，先看 control 是否为 null（没给参考图就是纯提示词）。',
        };
        saveRun({
          prompt_id: ctx.prompt_id, status: 'success', template: 'comfy_replace', params: ctx.params,
          outputs: rows.map((x) => ({ path: x.path, quality: x.metrics ? trimMetrics(x.metrics) : null })),
        });
        const visual = await visualPayload(rows, { view: 'auto' });
        const content = [{ type: 'text', text: J(payload) }];
        if (visual?.content?.length) content.push({ type: 'text', text: visual.note }, ...visual.content);
        return { content };
      }
    } catch (e) {
      return fail(`替换失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_composite',
  '合成：把一张「参考渲染」按 box 贴进底图（羽化接缝）。用于「分开渲染再合成」的参考图工作流 —— 例如单独渲染一架 C-130，再贴进街景。',
  {
    base: z.string().describe('底图路径'),
    patch: z.string().describe('要贴进去的图路径'),
    box: z.array(z.number()).length(4).describe('[x, y, w, h]：贴到底图的位置与尺寸'),
    feather: z.number().int().min(0).max(80).default(12),
  },
  async (args) => {
    try {
      if (!existsSync(args.base) || !existsSync(args.patch)) return fail('底图或贴图不存在');
      const r = compositeImages({ base: args.base, patch: args.patch, box: args.box, feather: args.feather });
      const p = previewFor(r.path, { maxSide: 1280 });
      return {
        content: [
          { type: 'text', text: J({ ok: true, out: r.out, box: r.box, feather: r.feather }) },
          { type: 'image', data: p.data, mimeType: p.mimeType },
        ],
      };
    } catch (e) {
      return fail(`合成失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_place',
  '把物体放进场景（修「贴纸感」）：自动生成「场景边缘 + 物体边缘」控制图与「保护电线结构」蒙版，供 ControlNet + 局部重绘。box 指定位置与大小。',
  {
    scene: z.string().optional().describe('底图本地路径（续等时可不传）'),
    object: z.string().optional().describe('物体图（参考渲染）本地路径'),
    box: z.array(z.number()).length(4).optional().describe('[x,y,w,h]'),
    prompt: z.string().optional(),
    denoise: z.number().min(0.2).max(1).default(0.85),
    strength: z.number().min(0).max(2).default(0.9),
    feather: z.number().int().min(0).max(80).default(18),
    protect: z.number().int().min(0).max(100).default(85).describe('保护场景结构的强度（电线/建筑边缘不被擦掉。'),
    steps: z.number().int().min(4).max(60).default(20),
    wait_s: z.number().int().min(0).max(55).default(45),
    prompt_id: z.string().optional(),
  },
  async (args) => {
    try {
      let ctx;
      if (args.prompt_id) {
        const p = join(EDIT_DIR, `${args.prompt_id}.json`);
        if (!existsSync(p)) return fail(`找不到${args.prompt_id} 的放置上下文`);
        ctx = JSON.parse(readFileSync(p, 'utf8'));
      } else {
        if (!args.scene || !args.object || !args.box || !args.prompt) return fail('需要 scene / object / box / prompt');
        const prep = placePrep({ scene: args.scene, object: args.object, box: args.box, feather: args.feather, protect: args.protect });
        const upS = await uploadImage(args.scene, { name: `place_src_${Date.now()}.png` });
        const upC = await uploadImage(prep.control, { name: `place_ctrl_${Date.now()}.png` });
        const upM = await uploadImage(prep.mask, { name: `place_mask_${Date.now()}.png` });
        const wf = {
          1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux1-dev-Q4_K_S.gguf' } },
          2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl_fp16.safetensors', type: 'flux' } },
          3: { class_type: 'VAELoader', inputs: { vae_name: 'flux-ae.safetensors' } },
          4: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: args.prompt } },
          5: { class_type: 'FluxGuidance', inputs: { conditioning: ['4', 0], guidance: 3.5 } },
          6: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: '' } },
          7: { class_type: 'LoadImage', inputs: { image: upS.name } },
          8: { class_type: 'LoadImageMask', inputs: { image: upM.name, channel: 'red' } },
          9: { class_type: 'VAEEncode', inputs: { pixels: ['7', 0], vae: ['3', 0] } },
          10: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['9', 0], mask: ['8', 0] } },
          11: { class_type: 'LoadImage', inputs: { image: upC.name } },
          12: { class_type: 'ControlNetLoader', inputs: { control_net_name: 'flux-cn-union-pro-2.0.safetensors' } },
          13: { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['5', 0], negative: ['6', 0], control_net: ['12', 0], image: ['11', 0], strength: args.strength, start_percent: 0.0, end_percent: 1.0, vae: ['3', 0] } },
          14: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['13', 0], negative: ['13', 1], latent_image: ['10', 0], seed: Math.floor(Math.random() * 2147483647), steps: args.steps, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: args.denoise } },
          15: { class_type: 'VAEDecode', inputs: { samples: ['14', 0], vae: ['3', 0] } },
          16: { class_type: 'SaveImage', inputs: { images: ['15', 0], filename_prefix: 'comfyforge/place' } },
        };
        const v = await preflight(wf);
        if (v.errors.length) return fail('放置工作流没通过校验', { errors: v.errors, warnings: v.warnings });
        const sub = await submit(wf);
        ctx = {
          prompt_id: sub.prompt_id, tpl: 'comfy_place',
          params: { prompt: args.prompt, box: args.box, denoise: args.denoise, strength: args.strength, protect: args.protect },
          source: args.scene, mask: prep.mask, control: prep.control, box: args.box,
        };
        mkdirSync(EDIT_DIR, { recursive: true });
        writeFileSync(join(EDIT_DIR, `${sub.prompt_id}.json`), JSON.stringify(ctx, null, 2), 'utf8');
      }

      const r = await waitFor(ctx.prompt_id, { timeoutS: args.wait_s });
      if (r.pending) {
        return text({ ok: true, pending: true, prompt_id: ctx.prompt_id, next: `comfy_place(prompt_id="${ctx.prompt_id}")` });
      }
      return await finishEdit(ctx, r.entry);
    } catch (e) {
      return fail(`放置失败：${e.message}`);
    }
  },
);

server.tool(
  'comfy_restructure',
  '全局重构（当局部重绘反复失败时用）：用「场景边缘+ 物体边缘」当构图草图，从空 latent 整张重画，让光照/透视从一开始就一致，而不是把物体贴上去。',
  {
    scene: z.string().optional().describe('构图参考：底图本地路径（续等时可不传）'),
    object: z.string().optional().describe('要放进构图的新物体图；不给就只按底图结构重画'),
    box: z.array(z.number()).length(4).optional().describe('物体在图里的位置 [x,y,w,h]；给了 object 才需要'),
    prompt: z.string().optional().describe('整张画面的描述'),
    steps: z.number().int().min(4).max(60).default(24),
    strength: z.number().min(0).max(2).default(0.65).describe('控制强度。>0.8 会把控制图的线当成画面内容（蓝图风，BUG-0018）'),
    control: z.enum(['edges', 'invert_edges', 'raw']).default('edges').describe('控制图来源：edges=照片转白底黑线（默认）；invert_edges=黑底白线；raw=直接用原图'),
    size: z.string().optional().describe('输出尺寸，如 "1024x1024"；不给就按控制图长宽比推（16 的倍数）'),
    guidance: z.number().min(0).max(10).default(3.5),
    wait_s: z.number().int().min(0).max(55).default(45),
    prompt_id: z.string().optional(),
  },
  async (args) => {
    try {
      let ctx;
      if (args.prompt_id) {
        const p = join(EDIT_DIR, `${args.prompt_id}.json`);
        if (!existsSync(p)) return fail(`找不到${args.prompt_id} 的重构上下文`);
        ctx = JSON.parse(readFileSync(p, 'utf8'));
      } else {
        if (!args.scene || !args.prompt) return fail('需要 scene 与 prompt（续等时只传 prompt_id）');
        let control;
        if (args.object && args.box) {
          control = placePrep({ scene: args.scene, object: args.object, box: args.box, feather: 0, protect: 0 }).control;
        } else if (args.control === 'raw') {
          control = args.scene;
        } else {
          // 只按底图结构重画：先把照片转成边缘图（白底黑线），而不是把整张照片当控制图
          control = edgeControl({ scene: args.scene, invert: args.control !== 'invert_edges' }).path;
        }
        // 输出尺寸跟控制图长宽比走，别一律正方形（否则透视被压扁）
        let width = 1024, height = 1024;
        if (args.size && /^\d+x\d+$/.test(args.size)) {
          [width, height] = args.size.split('x').map(Number);
        } else {
          try {
            const cm = imgMetrics([control])[0];
            const r16 = (n) => Math.max(256, Math.round(n / 16) * 16);
            if (cm?.width && cm?.height) {
              width = r16(cm.width);
              height = r16(cm.height);
            }
          } catch { /* 量不出就用 1024 方图 */ }
        }
        const upC = await uploadImage(control, { name: `restruct_ctrl_${Date.now()}.png` });
        const wf = {
          1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux1-dev-Q4_K_S.gguf' } },
          2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl_fp16.safetensors', type: 'flux' } },
          3: { class_type: 'VAELoader', inputs: { vae_name: 'flux-ae.safetensors' } },
          4: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: args.prompt } },
          5: { class_type: 'FluxGuidance', inputs: { conditioning: ['4', 0], guidance: args.guidance } },
          6: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: '' } },
          7: { class_type: 'LoadImage', inputs: { image: upC.name } },
          8: { class_type: 'ControlNetLoader', inputs: { control_net_name: 'flux-cn-union-pro-2.0.safetensors' } },
          9: { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['5', 0], negative: ['6', 0], control_net: ['8', 0], image: ['7', 0], strength: args.strength, start_percent: 0.0, end_percent: 1.0, vae: ['3', 0] } },
          10: { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: 1 } },
          11: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['9', 0], negative: ['9', 1], latent_image: ['10', 0], seed: Math.floor(Math.random() * 2147483647), steps: args.steps, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0 } },
          12: { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
          13: { class_type: 'SaveImage', inputs: { images: ['12', 0], filename_prefix: 'comfyforge/restructure' } },
        };
        const v = await preflight(wf);
        if (v.errors.length) return fail('重构工作流没通过校验', { errors: v.errors, warnings: v.warnings });
        const sub = await submit(wf);
        ctx = {
          prompt_id: sub.prompt_id, tpl: 'comfy_restructure',
          params: { prompt: args.prompt, strength: args.strength, control: args.control, size: `${width}x${height}`, box: args.box },
          source: args.scene, control_path: control,
        };
        mkdirSync(EDIT_DIR, { recursive: true });
        writeFileSync(join(EDIT_DIR, `${sub.prompt_id}.json`), JSON.stringify(ctx, null, 2), 'utf8');
      }
      const r = await waitFor(ctx.prompt_id, { timeoutS: args.wait_s });
      if (r.pending) return text({ ok: true, pending: true, prompt_id: ctx.prompt_id, next: `comfy_restructure(prompt_id="${ctx.prompt_id}")` });
      const parsed = parseHistoryEntry(r.entry);
      if (parsed.status !== 'success') {
        const diag = executionFailure(parsed);
        return fail(`重构失败：${diag.exception_message || parsed.status}`, { diagnosis: diag });
      }
      const { rows } = await inspectImages(parsed.images);
      const payload = {
        ok: true, prompt_id: ctx.prompt_id, template: ctx.tpl, params: ctx.params,
        outputs: rows.map((x) => ({ filename: x.filename, subfolder: x.subfolder, path: x.path, quality: x.metrics ? trimMetrics(x.metrics) : null })),
        note: '全局重构：整张重画，物体与场景的光照/透视为同一次采样产生。',
      };
      const visual = await visualPayload(rows, { view: 'auto' });
      const content = [{ type: 'text', text: J(payload) }];
      if (visual?.content?.length) content.push({ type: 'text', text: visual.note }, ...visual.content);
      return { content };
    } catch (e) {
      return fail(`重构失败：${e.message}`);
    }
  },
);
