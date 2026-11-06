// 50-styles.js — 全部样式集中在这里（方便整体换皮）。
// 字号只用三档：17（标题）/ 14（正文）/ 12.5（辅助）；间距 4 / 8 / 12 / 14 / 20。
// 颜色只从主题 token 取；彩色只用于「状态」，不拿去装饰。

function Styles() {
  return h('style', null, `
.cfl-root{
  position:relative;
  --cfl-radius:12px;
  --cfl-gap:14px;
  --cfl-pad:14px;
  --cfl-fs-title:17px;
  --cfl-fs-body:14px;
  --cfl-fs-meta:12.5px;
  display:flex;
  flex-direction:column;
  height:100%;
  min-height:560px;
  overflow:hidden;
  background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);
  font-size:var(--cfl-fs-body);
  line-height:1.55;
  /* 面板是操作界面，不是文档：默认不许选字，否则拖动画布会拖出一片选区 */
  user-select:none;
  -webkit-user-select:none;
}
/* 只有真正要读的文本允许选中复制 */
.cfl-param p,.cfl-error p,.cfl-empty-hint{user-select:text;-webkit-user-select:text}

/* ── 顶栏 ───────────────────────────────────────────── */
.cfl-top{display:flex;align-items:center;gap:16px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.cfl-brand{display:flex;align-items:center;gap:10px;min-width:0}
.cfl-brand-title{font-size:var(--cfl-fs-title);font-weight:600;margin:0;letter-spacing:-.01em;white-space:nowrap}
.cfl-brand-url{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cfl-conn{width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.cfl-conn.is-on{background:var(--dsw-alias-state-success-primary)}
.cfl-top-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
.cfl-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--cfl-fs-meta);white-space:nowrap}
.cfl-pill.is-run{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.cfl-pill.is-run i{width:7px;height:7px;border-radius:50%;background:currentColor;animation:cfl-pulse 1.3s ease-in-out infinite}
.cfl-btn{appearance:none;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:var(--cfl-fs-meta);line-height:1;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;white-space:nowrap}
.cfl-btn:hover{border-color:var(--dsw-alias-border-l2)}
.cfl-btn.is-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.cfl-btn:disabled{opacity:.45;cursor:default}
.cfl-btn.is-link{color:var(--dsw-alias-label-secondary)}
.cfl-btn.is-danger{margin-top:10px;border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,var(--dsw-alias-border-l1));color:var(--dsw-alias-state-error-primary)}
.cfl-btn.is-danger:hover{border-color:var(--dsw-alias-state-error-primary)}

/* ── 三栏 ───────────────────────────────────────────── */
.cfl-main{flex:1;min-width:0;min-height:0;display:grid;grid-template-columns:300px minmax(0,1fr) 360px;gap:var(--cfl-gap);padding:var(--cfl-gap);overflow:hidden}
.cfl-col{min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--cfl-radius);overflow:hidden}
.cfl-col-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:13px 14px 11px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.cfl-col-head h2{font-size:var(--cfl-fs-body);font-weight:600;margin:0}
.cfl-col-head > span{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.cfl-col-body{flex:1;min-height:0;overflow:auto;padding:10px}
.cfl-col-canvas .cfl-col-body{padding:12px}
.cfl-col-foot{flex:none;padding:9px 14px 11px;border-top:1px solid var(--dsw-alias-border-l1)}
.cfl-col-inspector{background:transparent;border:0;border-radius:0;overflow:auto;padding-right:2px;gap:12px}

/* ── 卡片（右栏分块）────────────────────────────────── */
.cfl-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--cfl-radius);overflow:hidden;flex:none}
.cfl-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:13px 14px 9px}
.cfl-card-title{font-size:var(--cfl-fs-body);font-weight:600;margin:0}
.cfl-card-aside{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary)}
.cfl-card-body{padding:0 14px 14px}

/* ── 时间线 ─────────────────────────────────────────── */
.cfl-group{margin-bottom:6px}
.cfl-group-label{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary);padding:8px 8px 4px}
.cfl-run{display:flex;align-items:center;gap:10px;width:100%;padding:8px;border:1px solid transparent;border-radius:10px;background:transparent;color:inherit;text-align:left;cursor:pointer}
.cfl-run:hover{background:var(--dsw-alias-bg-layer-2)}
.cfl-run.is-active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.cfl-run-text{display:flex;flex-direction:column;min-width:0;flex:1;gap:2px}
.cfl-run-label{font-size:var(--cfl-fs-body);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cfl-run-meta{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.cfl-run-thumb{width:44px;height:44px;border-radius:8px;object-fit:cover;flex:none;background:var(--dsw-alias-bg-layer-2)}
.cfl-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.cfl-dot.is-running{background:var(--dsw-alias-brand-primary);animation:cfl-pulse 1.3s ease-in-out infinite}
.cfl-dot.is-success{background:var(--dsw-alias-state-success-primary)}
.cfl-dot.is-error{background:var(--dsw-alias-state-error-primary)}
.cfl-dot.is-interrupted{background:var(--dsw-alias-state-warn-primary)}

/* ── 画布 / 节点 ────────────────────────────────────── */
.cfl-col-canvas .cfl-col-body{padding:12px;overflow:hidden;display:flex}
.cfl-canvas-wrap{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;border-radius:10px;background:var(--dsw-alias-bg-layer-2);background-image:radial-gradient(color-mix(in srgb,var(--dsw-alias-border-l2) 60%,transparent) 1px,transparent 1px);background-size:18px 18px;cursor:grab;touch-action:none}
.cfl-canvas-wrap:active{cursor:grabbing}
.cfl-canvas-stage{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
.cfl-canvas-stage svg{display:block}
.cfl-canvas-hint{position:absolute;left:10px;bottom:9px;font-size:12px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent);padding:3px 9px;border-radius:6px;pointer-events:none}
.cfl-tools{display:flex;align-items:center;gap:6px}
.cfl-tools-meta{margin-right:4px}
.cfl-icon-btn{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:14px;line-height:1;padding:0}
.cfl-icon-btn:hover{border-color:var(--dsw-alias-border-l2)}
.cfl-icon-btn:disabled{opacity:.4;cursor:default}
.cfl-zoom-val{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:40px;text-align:center;font-variant-numeric:tabular-nums}
.cfl-tool-btn{height:24px;padding:0 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
.cfl-tool-btn:hover{border-color:var(--dsw-alias-border-l2)}
.cfl-tool-btn:disabled{opacity:.4;cursor:default}
.cfl-node-box{fill:var(--dsw-alias-bg-layer-1);stroke:var(--dsw-alias-border-l2);stroke-width:1.2}
.cfl-node-title{fill:var(--dsw-alias-label-primary);font-size:13.5px;font-weight:600}
.cfl-node-sub{fill:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
.cfl-node-state{fill:var(--dsw-alias-state-idle-primary)}
.cfl-node.is-running .cfl-node-box{stroke:var(--dsw-alias-brand-primary);stroke-width:2.2;fill:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,var(--dsw-alias-bg-layer-1))}
.cfl-node.is-running .cfl-node-state{fill:var(--dsw-alias-brand-primary);animation:cfl-pulse 1.1s ease-in-out infinite}
.cfl-node.is-done .cfl-node-state{fill:var(--dsw-alias-state-success-primary)}
.cfl-node.is-done .cfl-node-box{stroke:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,var(--dsw-alias-border-l2))}
.cfl-node.is-cached .cfl-node-box{stroke-dasharray:5 4}
.cfl-node.is-cached .cfl-node-state{fill:transparent;stroke:var(--dsw-alias-label-secondary);stroke-width:1.4}
.cfl-node.is-error .cfl-node-box{stroke:var(--dsw-alias-state-error-primary);stroke-width:2.2;fill:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,var(--dsw-alias-bg-layer-1))}
.cfl-node.is-error .cfl-node-state{fill:var(--dsw-alias-state-error-primary)}
.cfl-edge{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:1.4;opacity:.8}
.cfl-edge.is-done{stroke:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,var(--dsw-alias-border-l2));opacity:1}
.cfl-legend{display:flex;flex-wrap:wrap;gap:14px}
.cfl-legend-item{display:inline-flex;align-items:center;gap:6px;font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary)}
.cfl-legend-item i{width:9px;height:9px;border-radius:3px;display:inline-block;background:var(--dsw-alias-state-idle-primary)}
.cfl-lg-run i{background:var(--dsw-alias-brand-primary)}
.cfl-lg-done i{background:var(--dsw-alias-state-success-primary)}
.cfl-lg-cache i{background:transparent;border:1.4px dashed var(--dsw-alias-label-secondary)}
.cfl-lg-error i{background:var(--dsw-alias-state-error-primary)}

/* ── 右栏内容 ───────────────────────────────────────── */
.cfl-kv{display:flex;flex-direction:column;gap:7px;margin:0}
.cfl-kv-row{display:grid;grid-template-columns:52px 1fr;gap:10px;align-items:baseline}
.cfl-kv dt{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary)}
.cfl-kv dd{margin:0;font-size:var(--cfl-fs-body);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cfl-progress-wrap{margin-top:12px}
.cfl-progress{height:6px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.cfl-progress i{display:block;height:100%;border-radius:99px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
.cfl-progress.is-indeterminate i{animation:cfl-slide 1.3s ease-in-out infinite}
.cfl-progress-meta{display:flex;justify-content:space-between;font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary);margin-top:6px;font-variant-numeric:tabular-nums}
.cfl-preview-media{display:block;width:100%;max-height:300px;object-fit:contain;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.cfl-preview-blank{display:flex;align-items:center;justify-content:center;height:150px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:var(--cfl-fs-meta);text-align:center;padding:0 14px;line-height:1.6}
/* 产物文件没了时的占位：宁可写清楚"已删除"，也不要留一块灰或者裂图 */
.cfl-media-bad{display:flex;align-items:center;justify-content:center;width:100%;height:100%;min-height:42px;padding:6px;
  border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  font-size:11.5px;text-align:center;box-sizing:border-box}
.cfl-thumbs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
/* 产物格 + 右上角"选这张" */
.cfl-thumb-wrap{position:relative;min-width:0}
.cfl-pick{position:absolute;right:5px;top:5px;width:23px;height:23px;display:flex;align-items:center;justify-content:center;
  padding:0;border-radius:7px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-bg-base) 78%,transparent);color:var(--dsw-alias-label-secondary);
  font-size:13px;line-height:1;cursor:pointer;backdrop-filter:blur(2px)}
.cfl-pick:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.cfl-pick.is-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
/* 任务条 */
.cfl-task-label{font-size:13px;color:var(--dsw-alias-label-primary);margin-bottom:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cfl-task-chips{display:flex;align-items:center;gap:6px;overflow-x:auto;padding:9px 0 2px;scrollbar-width:none}
.cfl-task-chips::-webkit-scrollbar{display:none}
.cfl-task-chips-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);flex:none;margin-right:1px}
.cfl-task-runs{display:flex;gap:6px;overflow-x:auto;padding:9px 0 2px;scrollbar-width:none}
.cfl-task-runs::-webkit-scrollbar{display:none}
.cfl-task-run{flex:none;width:46px;height:46px;padding:0;border-radius:8px;overflow:hidden;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center}
.cfl-task-run img{width:100%;height:100%;object-fit:cover;display:block}
.cfl-task-run:hover{border-color:var(--dsw-alias-border-l2)}
.cfl-task-run.is-active{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary)}
.cfl-task-run.is-run{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1))}
.cfl-task-run-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.cfl-thumb{display:block;position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;aspect-ratio:1/1;background:var(--dsw-alias-bg-layer-2)}
.cfl-thumb:hover{border-color:var(--dsw-alias-border-l2)}
.cfl-thumb-media{width:100%;height:100%;object-fit:cover;display:block}
.cfl-audio-badge{display:flex;align-items:center;justify-content:center;height:100%;font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary)}
.cfl-params{display:flex;flex-direction:column;gap:10px}
.cfl-param{display:grid;grid-template-columns:52px 1fr;gap:10px;align-items:start}
.cfl-param span{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary);padding-top:1px}
.cfl-param p{margin:0;font-size:var(--cfl-fs-body);line-height:1.6;word-break:break-word}

/* ── 状态块 ─────────────────────────────────────────── */
.cfl-empty{padding:26px 10px;text-align:center}
.cfl-empty-title{font-size:var(--cfl-fs-body);font-weight:600;margin:0 0 4px}
.cfl-empty-hint{font-size:var(--cfl-fs-meta);color:var(--dsw-alias-label-secondary);margin:0;line-height:1.6}
.cfl-error{margin-top:12px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
.cfl-error b{display:block;font-size:var(--cfl-fs-meta);color:var(--dsw-alias-state-error-primary);margin-bottom:3px}
.cfl-error p{margin:0;font-size:var(--cfl-fs-meta);line-height:1.6;word-break:break-word}
.cfl-banner{margin:0 14px 12px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-state-error-primary);font-size:var(--cfl-fs-meta)}
.cfl-banner b{margin-right:6px;color:var(--dsw-alias-state-error-primary)}

/* ── 工作台外壳：左导航 + 内容区 ─────────────────────── */
.cfl-shell{flex:1;min-height:0;display:flex;overflow:hidden}
.cfl-rail{width:176px;flex:none;display:flex;flex-direction:column;gap:2px;padding:14px 10px;border-right:1px solid var(--dsw-alias-border-l1)}
.cfl-rail-title{font-size:11.5px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);padding:2px 10px 10px}
.cfl-rail-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13.5px;text-align:left}
.cfl-rail-item:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.cfl-rail-item.is-active{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.cfl-rail-item span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cfl-rail-item em{font-style:normal;font-size:11.5px;line-height:1.2;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.cfl-w-content{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;padding:14px;overflow:hidden}
.cfl-w-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex:none;margin-bottom:12px}
.cfl-w-title{font-size:16px;font-weight:600;margin:0 0 2px}
.cfl-w-sub{font-size:12.5px;color:var(--dsw-alias-label-secondary);margin:0}
.cfl-w-actions{display:flex;align-items:center;gap:8px}
.cfl-chips{display:flex;gap:6px}
.cfl-chip{height:26px;padding:0 10px;border-radius:99px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12.5px;cursor:pointer;white-space:nowrap}
.cfl-chip.is-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.cfl-grid-wrap{flex:1;min-height:0;overflow:auto}
.cfl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:12px;align-content:start;padding-bottom:4px}
.cfl-tile{position:relative;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);cursor:pointer;text-align:left;display:block;width:100%}
.cfl-tile:hover{border-color:var(--dsw-alias-border-l2)}
.cfl-tile-frame{position:relative;display:block;width:100%;aspect-ratio:1/1;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.cfl-tile-media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.cfl-tile-badge{position:absolute;top:6px;left:6px;font-size:11px;padding:1px 6px;border-radius:6px;background:rgba(0,0,0,.55);color:#fff}
.cfl-tile-meta{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;gap:1px;padding:20px 8px 6px;background:linear-gradient(to top,rgba(0,0,0,.72),rgba(0,0,0,0))}
.cfl-tile-name{font-size:12px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cfl-tile-sub{font-size:11px;color:rgba(255,255,255,.78);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cfl-more{display:flex;justify-content:center;padding:14px 0 6px}
.cfl-lightbox{position:absolute;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:20}
.cfl-lightbox-body{width:min(78%,900px);max-height:86%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}
.cfl-lightbox-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12.5px}
.cfl-lightbox-media{width:100%;max-height:62vh;object-fit:contain;background:#000}
.cfl-lightbox-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.cfl-w-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.cfl-w-canvas{flex:1;min-height:0;display:flex}
.cfl-w-canvas > .cfl-col{flex:1}
.cfl-rows{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px}
.cfl-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer;text-align:left}
.cfl-row:hover{border-color:var(--dsw-alias-border-l2)}
.cfl-row-main{display:flex;flex-direction:column;min-width:0;flex:1}
.cfl-row-title{font-size:14px}
.cfl-row-sub{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cfl-row-tag{font-size:11.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 6px;white-space:nowrap}
.cfl-row-time{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}

/* ── 右侧整列停靠面板（与左栏相对的那一列）──
   语言和左栏一致：通高、直角、只有一条左边线；分区靠留白 + 一条细线，不靠卡片套卡片。 */
.cfl-dock2{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;
  background:var(--dsw-alias-bg-base,#17191c);color:var(--dsw-alias-label-primary,#e6e8eb);
  border-left:1px solid var(--dsw-alias-border-l1,#2f3338)}
.cfl-dock2-head{display:flex;align-items:center;gap:8px;height:40px;padding:0 14px;flex:none}
.cfl-dock2-title{font-size:13px;font-weight:600;letter-spacing:.01em}
.cfl-dock2-live{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa1a9);font-variant-numeric:tabular-nums}
.cfl-dock2-tabs{flex:none;padding:0 12px 8px}
.cfl-seg{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1e2124);flex-wrap:wrap;max-width:100%}
.cfl-seg-btn{display:flex;align-items:center;gap:5px;height:24px;padding:0 10px;border:0;border-radius:6px;
  background:transparent;color:var(--dsw-alias-label-secondary,#9aa1a9);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.cfl-seg-btn:hover{color:var(--dsw-alias-label-primary,#e6e8eb)}
.cfl-seg-btn.is-on{background:var(--dsw-alias-bg-base,#17191c);color:var(--dsw-alias-label-primary,#e6e8eb);
  box-shadow:0 1px 2px color-mix(in srgb,#000 30%,transparent)}
.cfl-seg-num{font-size:11px;opacity:.62;font-variant-numeric:tabular-nums}
.cfl-dock2-body{flex:1;min-height:0;overflow:auto}
.cfl-dock2-run{flex:1;min-height:0;display:flex;flex-direction:column}
.cfl-dock2-list{flex:none;display:flex;flex-direction:column;min-height:0;max-height:36%;
  border-top:1px solid var(--dsw-alias-border-l1,#2f3338);border-bottom:1px solid var(--dsw-alias-border-l1,#2f3338)}
.cfl-dock2-list.is-folded{max-height:none;border-bottom:0}
.cfl-dock2-listhead{display:flex;align-items:center;gap:8px;width:100%;height:30px;padding:0 14px;
  border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9aa1a9);
  font:inherit;font-size:12px;cursor:pointer;text-align:left;flex:none}
.cfl-dock2-listhead:hover{color:var(--dsw-alias-label-primary,#e6e8eb)}
.cfl-dock2-count{font-size:11px;opacity:.7;font-variant-numeric:tabular-nums}
.cfl-dock2-fold{margin-left:auto;font-size:11px;opacity:.8}
.cfl-dock2-listbody{flex:1;min-height:0;overflow:auto;padding:0 8px 8px}
.cfl-dock2-detail{flex:1;min-height:0;overflow:auto}
/* ── 视觉整理（窄列里空间稀缺，只留有信息量的东西）──
  1) 监测条那张空图表在 420px 里只是一块噪点：去掉折线，只留三行读数。
  2) 读数字改用等宽数字 + 明确的行高，扫一眼就能对比。
  3) 分区之间用留白分开，不用再套一层卡片。 */
.cfl-dock2 .cfl-sys-spark{display:none}
.cfl-dock2 .cfl-sys{padding:6px 14px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#2f3338)}
.cfl-dock2 .cfl-sys-main{display:block}
.cfl-dock2 .cfl-sys-stats{display:flex;flex-direction:column;gap:1px;margin-top:2px}
.cfl-dock2 .cfl-sys-stat{display:flex;justify-content:space-between;gap:10px;font-size:12px;line-height:1.75;
  color:var(--dsw-alias-label-secondary,#9aa1a9);font-variant-numeric:tabular-nums}
/* 产物做成"胶卷条"：一行横滑，不抢纵向高度；点开原地放大。
   注意：这套规则必须**全局**，不能只写在 .cfl-dock2 下面 ——
   Inspector 组件主页大屏也在用，漏了作用域就会出现"一张图被拉成一堵墙"。 */
.cfl-film{display:flex;gap:6px;overflow-x:auto;padding:2px 0 6px;align-items:flex-start}
.cfl-film-item{flex:0 0 72px;width:72px;height:72px;max-width:72px;max-height:72px;padding:0;
  border:1px solid var(--dsw-alias-border-l1,#2f3338);border-radius:8px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2,#26292e);cursor:zoom-in}
.cfl-film-item:hover{border-color:var(--dsw-alias-brand-primary,#5b9dff)}
.cfl-film-media{width:100%;height:100%;max-width:72px;max-height:72px;object-fit:cover;display:block}
/* 原地放大：点预览图/产物后，在同一位置显示大图（不用覆盖层，窄列里最稳） */
.cfl-preview-btn{display:block;width:100%;padding:0;border:0;background:transparent;cursor:zoom-in}
.cfl-big{position:relative;display:flex;flex-direction:column;gap:6px}
.cfl-big-img{width:100%;max-height:min(46vh,420px);object-fit:contain;border-radius:8px;background:#000}
/* 收起浮在右上角：视频的播放条在底部，两者不抢位置，也不会被视频撑出可视区 */
.cfl-big-close{position:absolute;right:8px;top:8px;z-index:2;height:26px;padding:0 12px;border-radius:6px;
  border:1px solid rgba(255,255,255,.34);background:rgba(0,0,0,.62);color:#f2f4f6;font:inherit;font-size:12px;
  cursor:pointer;backdrop-filter:blur(4px)}
.cfl-big-close:hover{background:rgba(0,0,0,.82);border-color:#fff}
.cfl-big-name{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa1a9);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cfl-big-bar{display:none}
/* 灯箱样式保留但不再使用（改成原地放大，避免覆盖层被裁） */
.cfl-lb{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.84);cursor:zoom-out;padding:24px}
.cfl-lb-img{max-width:100%;max-height:calc(100% - 48px);object-fit:contain;border-radius:6px;
  box-shadow:0 24px 60px rgba(0,0,0,.5)}
.cfl-lb-bar{position:absolute;left:0;right:0;bottom:0;height:42px;display:flex;align-items:center;gap:10px;
  padding:0 14px;background:rgba(0,0,0,.55);color:#e6e8eb;font-size:12px}
.cfl-lb-name{opacity:.82;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cfl-lb-close{margin-left:auto;height:26px;padding:0 12px;border-radius:6px;border:1px solid rgba(255,255,255,.3);
  background:transparent;color:#e6e8eb;font-size:12px;cursor:pointer}
.cfl-lb-close:hover{background:rgba(255,255,255,.12)}
.cfl-dock2 .cfl-thumbs,.cfl-dock2 .cfl-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.cfl-dock2 .cfl-tile-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  line-height:1.35;word-break:break-all}
.cfl-dock2 .cfl-w-content{padding:4px 12px 12px}
.cfl-dock2 .cfl-w-head{padding:6px 2px 10px;gap:8px}
.cfl-dock2 .cfl-w-title{font-size:13px;font-weight:600;margin:0}
.cfl-dock2 .cfl-w-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa1a9);margin:2px 0 0}
/* 停在窄列里时，预览图必须限高：否则一张竖图吃掉半屏，下面的产物和参数全被挤出去 */
.cfl-dock2 .cfl-preview-media{max-height:180px;width:100%;object-fit:contain;border-radius:8px}
/* 选中项：一条 2px 强调边 + 略深的底，扫一眼就知道在看哪一条 */
.cfl-dock2 .cfl-run{position:relative;border-radius:8px}
.cfl-dock2 .cfl-run.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b9dff) 10%,transparent)}
.cfl-dock2 .cfl-run.is-active::before{content:'';position:absolute;left:0;top:6px;bottom:6px;width:2px;border-radius:2px;
  background:var(--dsw-alias-brand-primary,#5b9dff)}
/* 列表高度给到 44%，行距收紧一点，一屏多看两条 */
.cfl-dock2-list{max-height:44%}
.cfl-dock2 .cfl-thumbs{grid-template-columns:repeat(2,minmax(0,1fr))}
/* ── 抽屉（可拖动、可缩放；右侧栏不可用时的退路）──
   注意背景色都带兜底值：shell.overlay 里拿不到 DSH 的主题变量，
   只写 var(--dsw-alias-bg-base) 会解析失败 → 面板变半透明，底下的对话文字透出来。 */
.cfl-float{position:absolute;z-index:41;pointer-events:auto;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base,#17191c);border:1px solid var(--dsw-alias-border-l2,#3d444b);border-radius:12px;
  box-shadow:0 18px 48px color-mix(in srgb,#000 38%,transparent),0 2px 8px color-mix(in srgb,#000 24%,transparent);
  overflow:hidden;color:var(--dsw-alias-label-primary,#e6e8eb)}
.cfl-float-bar{display:flex;align-items:center;gap:8px;height:44px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#2f3338);flex:none;background:var(--dsw-alias-bg-layer-1,#1e2124);cursor:move;user-select:none;touch-action:none}
.cfl-float-body{background:var(--dsw-alias-bg-base,#17191c)}
.cfl-float-title{font-size:13px;font-weight:600;white-space:nowrap}
.cfl-float-meta{font-size:12px;color:var(--dsw-alias-label-secondary);margin-left:auto;margin-right:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cfl-float-body{flex:1;min-height:0;overflow:hidden;display:flex}
.cfl-float-body > .cfl-root{flex:1}
.cfl-float-grip{position:absolute;left:0;top:0;bottom:0;width:5px;cursor:ew-resize}
.cfl-float-grip:hover{background:var(--dsw-alias-border-l2)}
/* 铺满视口的一层：只用来给里面的东西定位，本身不吃点击。
   shell.overlay 的容器是 0×0 且贴原点，所以外层尺寸一律用 vw/vh，
   内部再靠 flex 推位置——这样不会算到 0 上。 */
.cfl-layer{position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:60;
  display:flex;align-items:flex-end;justify-content:flex-end;padding:16px;
  pointer-events:none;box-sizing:border-box}
.cfl-layer > *{pointer-events:auto}
/* 右下角改大小 */
.cfl-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 46%,var(--dsw-alias-border-l2) 46%,var(--dsw-alias-border-l2) 56%,transparent 56%,transparent 68%,var(--dsw-alias-border-l2) 68%,var(--dsw-alias-border-l2) 78%,transparent 78%)}
.cfl-resize:hover{background:linear-gradient(135deg,transparent 46%,var(--dsw-alias-brand-primary) 46%,var(--dsw-alias-brand-primary) 56%,transparent 56%,transparent 68%,var(--dsw-alias-brand-primary) 68%,var(--dsw-alias-brand-primary) 78%,transparent 78%)}
/* 入口按钮的定位壳：绝对定位到 (x,y)，里面只放按钮和 hover 才出现的 × */
.cfl-pill-wrap{position:absolute;pointer-events:auto}
.cfl-pill-wrap .cfl-dock{width:100%;height:100%;justify-content:center;cursor:grab;touch-action:none;user-select:none}
.cfl-pill-wrap .cfl-dock:active{cursor:grabbing}
.cfl-pill-hide{position:absolute;right:-7px;top:-7px;width:16px;height:16px;padding:0;line-height:14px;
  border:1px solid var(--dsw-alias-border-l2,#3d444b);border-radius:50%;background:var(--dsw-alias-bg-base,#17191c);
  color:var(--dsw-alias-label-secondary,#9aa1a9);font-size:11px;cursor:pointer;opacity:.6;transition:opacity .12s ease}
.cfl-pill-wrap:hover .cfl-pill-hide{opacity:1}
.cfl-pill-hide:hover{color:var(--dsw-alias-state-error-primary,#f85149);border-color:var(--dsw-alias-state-error-primary,#f85149)}
/* 收起后的入口：右下角一张小卡片。 */
.cfl-dock{display:flex;align-items:center;gap:8px;height:38px;padding:0 14px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:19px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font-size:13px;font-weight:500;line-height:1;cursor:pointer;appearance:none;
  box-shadow:0 6px 22px color-mix(in srgb,#000 26%,transparent);
  transition:border-color .12s ease,transform .12s ease,background .12s ease}
.cfl-dock:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);transform:translateY(-1px)}
.cfl-dock:active{transform:translateY(0)}
.cfl-dock:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cfl-dock-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.cfl-dock-label{white-space:nowrap}
.cfl-dock-meta{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.cfl-dock.is-run{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 50%,var(--dsw-alias-border-l2))}
.cfl-dock.is-run .cfl-dock-dot{background:var(--dsw-alias-brand-primary);animation:cfl-pulse 1.3s ease-in-out infinite}
.cfl-dock.is-off .cfl-dock-dot{background:var(--dsw-alias-state-error-primary)}
.cfl-root.is-compact{min-height:0}
.cfl-main.is-compact{display:flex;flex-direction:column;padding:0;gap:0;overflow:hidden}
.cfl-main.is-compact .cfl-col-inspector{padding-right:0;gap:0}
/* 停靠栏里不要"卡片套卡片"：改成原生侧栏那种分隔线 + 通栏内容 */
.cfl-float .cfl-card{border:0;border-radius:0;background:transparent}
.cfl-float .cfl-card + .cfl-card{border-top:1px solid var(--dsw-alias-border-l1)}
.cfl-float .cfl-card-head{padding:12px 14px 8px}
.cfl-float .cfl-card-body{padding:0 14px 14px}
.cfl-float .cfl-preview-media{width:100%;max-height:38vh;border-radius:0;object-fit:contain;background:var(--dsw-alias-bg-layer-2);display:block}
.cfl-float .cfl-preview-blank{border-radius:0;height:180px}
.cfl-float .cfl-thumbs{gap:6px}

/* ── 系统监控条（显存/内存/CPU + 折线 + 看门狗）──
   放停靠栏顶部：不滚走，随时能看出"能不能跑、会不会 OOM"。
   只在真的出问题时上色，正常状态是灰的——装饰色不抢图。 */
.cfl-sys{flex:none;padding:8px 12px 9px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.cfl-sys-main{display:flex;align-items:stretch;gap:12px}
.cfl-sys-spark{flex:1;min-width:60px;height:34px;display:block;overflow:visible}
.cfl-sys-spark.is-empty{background:linear-gradient(var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-2));border-radius:4px;opacity:.5}
.cfl-spark-base{stroke:var(--dsw-alias-border-l1);stroke-width:1;vector-effect:non-scaling-stroke}
.cfl-spark-mid{stroke:var(--dsw-alias-border-l1);stroke-width:1;stroke-dasharray:3 4;opacity:.75;vector-effect:non-scaling-stroke}
.cfl-spark-area{fill:var(--dsw-alias-brand-primary);opacity:.18;stroke:none}
.cfl-spark-vram{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:1.7;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.cfl-spark-cpu{fill:none;stroke:var(--dsw-alias-label-secondary);stroke-width:1.1;stroke-dasharray:3 2;opacity:.8;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.cfl-sys-stats{flex:none;display:flex;flex-direction:column;justify-content:center;gap:2px}
.cfl-sys-stat{display:flex;align-items:baseline;gap:9px;font-size:12px;line-height:1.38}
.cfl-sys-stat em{font-style:normal;color:var(--dsw-alias-label-secondary);width:28px;flex:none;font-size:11.5px}
.cfl-sys-stat b{font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);white-space:nowrap}
.cfl-sys-stat.is-warn b{color:var(--dsw-alias-state-warn-primary)}
.cfl-sys-note{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.cfl-sys-alert{display:flex;align-items:baseline;gap:7px;margin-top:7px;font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
.cfl-sys-alert b{flex:none;color:var(--dsw-alias-state-error-primary);font-weight:600}
.cfl-sys.is-warn .cfl-sys-alert b{color:var(--dsw-alias-state-warn-primary)}
.cfl-sys.is-down .cfl-sys-spark{opacity:.4}
.cfl-sys.is-down .cfl-sys-stat b{color:var(--dsw-alias-state-error-primary)}

@keyframes cfl-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes cfl-slide{0%{transform:translateX(-10%)}50%{transform:translateX(160%)}100%{transform:translateX(-10%)}}

@media (max-width:1180px){
  .cfl-main{grid-template-columns:264px minmax(0,1fr) 320px}
}
@media (max-width:960px){
  .cfl-main{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto auto;overflow:auto}
  .cfl-col-timeline{max-height:260px}
  .cfl-col-canvas{min-height:320px}
  .cfl-col-inspector{overflow:visible}
}
` )
}
