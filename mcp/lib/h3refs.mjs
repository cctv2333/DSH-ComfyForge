// lib/h3refs.mjs — H3 的 <Picture n> 编号必须从「图里实际喂了几张、按什么顺序」推出来
//
// 为什么不能手写：H3 的 <Picture N> 是**按类型、从 1 开始**的顺序标签，指的是
// 「这个消费节点上第 N 张参考图」，不是文件名、不是上传顺序，也不是人物编号。
// 提示词里写 <Picture 2> 而图里第 2 张是另一张 → 模型照着错的图生成，
// 而且 ComfyUI 的 POST /prompt **不会报错**，只会跑 5 分钟给你一条跑偏的片子。
//
// 规则（照官方协议与实现核对过）：
//   MiniMaxH3ImageToVideo      的参考图顺序 = first_frame, last_frame
//   MiniMaxH3ReferenceToVideo  的参考图顺序 = ref_images.ref_image_0, 1, 2, …
//   ↑ 与节点 execute() 里 ref_images.values() 的遍历顺序一致
//
// 三条纪律：
//   1. 只跟随**单图**操作节点（缩放/裁剪/翻转/重定向），它们不改变张数与顺序。
//   2. 遇到 switch / batch / 未知节点 → 标 unresolved，**不猜**。
//   3. 同一个图源被两个槽使用 → 无法给出唯一编号 → 返回 undefined。

/** 已知「单进单出」的图像操作：跳过去继续往上找 LoadImage */
const SINGLE_IMAGE_INPUTS = Object.freeze({
  ImageScale: 'image',
  ImageScaleBy: 'image',
  ImageCrop: 'image',
  ImagePadForOutpaint: 'image',
  ImageInvert: 'image',
  ImageFlip: 'image',
  Reroute: null, // null = 取它的第一个输入
});

const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** ["8", 0] 这种连线；也容忍 ["8", 0, "IMAGE"] 的三元写法 */
function asLink(v) {
  if (!Array.isArray(v) || v.length < 2) return undefined;
  const [node, slot] = v;
  if (!(typeof node === 'string' || Number.isSafeInteger(node))) return undefined;
  if (!Number.isInteger(slot)) return undefined;
  return [String(node), slot];
}

/** LoadImage 里的 image 字段空/None 视为「没有图」 */
export function imageFieldPresent(value) {
  return typeof value === 'string' && Boolean(value.trim()) && !/^(?:none|null)$/i.test(value.trim());
}

/**
 * 从 API 图里读出每个 H3 消费节点的参考图顺序。
 * @param {Record<string, {class_type: string, inputs: Record<string, any>}>} graph
 */
export function readReferenceImageOrders(graph) {
  if (!isRecord(graph)) return [];
  const nodeAt = (id) => (isRecord(graph[id]) && typeof graph[id].class_type === 'string' && isRecord(graph[id].inputs)
    ? graph[id]
    : undefined);

  const imageSource = (value, visited = new Set()) => {
    if (value === undefined || value === null || value === '') return { present: false };
    const edge = asLink(value);
    // 只认第 0 个输出；不是连线（比如开关/条件）→ 不知道是几张，别猜
    if (!edge || edge[1] !== 0 || visited.has(edge[0])) return { present: true, unresolved: true };
    const node = nodeAt(edge[0]);
    if (!node) return { present: true, unresolved: true };
    if (node.class_type === 'LoadImage' && typeof node.inputs.image === 'string') {
      return { source: { nodeId: edge[0], inputName: 'image' }, present: imageFieldPresent(node.inputs.image) };
    }
    if (!(node.class_type in SINGLE_IMAGE_INPUTS)) return { present: true, unresolved: true };
    const inputName = SINGLE_IMAGE_INPUTS[node.class_type];
    const next = inputName === null ? Object.values(node.inputs)[0] : node.inputs[inputName];
    visited.add(edge[0]);
    return imageSource(next, visited);
  };

  const orders = [];
  for (const [consumerNodeId, node] of Object.entries(graph)) {
    const cls = node?.class_type;
    let entries;
    if (cls === 'MiniMaxH3ImageToVideo') {
      entries = ['first_frame', 'last_frame']
        .filter((name) => name in node.inputs)
        .map((name) => [name, node.inputs[name]]);
    } else if (cls === 'MiniMaxH3ReferenceToVideo') {
      // 展开后的键是 ref_images.ref_image_N，顺序 = 节点 execute() 的遍历顺序
      entries = Object.entries(node.inputs).flatMap(([inputName, value]) => {
        if (/^ref_images\.ref_image_\d+$/.test(inputName)) return [[inputName, value]];
        // 也兼容没展开的嵌套写法
        if (inputName === 'ref_images' && isRecord(value)) {
          return Object.entries(value).map(([k, v]) => [`ref_images.${k}`, v]);
        }
        return [];
      });
    } else {
      continue;
    }
    if (!entries.length) continue;
    orders.push({
      consumerNodeId,
      images: entries.map(([inputName, value]) => ({ inputName, ...imageSource(value) })),
    });
  }
  return orders;
}

/**
 * 给定「选中的槽位」（第几张输入图会被真正用上），算出提示词里该写哪几个 Picture 编号。
 * @param {{images: Array<{inputName: string, source?: any, present: boolean, unresolved?: boolean}>}[]} orders
 * @param {number[]} selectedSlots 槽位下标（按输入顺序，从 0 开始）
 * @returns {number[]|undefined} 对应 selectedSlots 的 Picture 编号；无法唯一确定时 undefined
 */
export function resolvePictureNumbers(orders, selectedSlots) {
  if (!Array.isArray(selectedSlots) || !selectedSlots.length) return [];
  if (selectedSlots.some((s) => !Number.isInteger(s) || s < 0)) return undefined;
  // 同一个槽被选两次 → 提示词里没有唯一编号可写
  if (new Set(selectedSlots).size !== selectedSlots.length) return undefined;
  if (!Array.isArray(orders) || !orders.length) return undefined;

  const selected = new Set(selectedSlots);
  let answer;
  for (const order of orders) {
    if (order.images.some((img) => img.unresolved)) return undefined;
    if (selectedSlots.some((s) => s >= order.images.length)) return undefined;

    const numbers = new Map();
    let picture = 0;
    order.images.forEach((img, index) => {
      // ComfyUI 会把未选中的槽恢复成默认值：真的有图就仍然占一个 Picture 编号
      if (!selected.has(index) && !img.present) return;
      picture += 1;
      if (selected.has(index)) {
        // 同一张图被两个槽消费 → 一个源对应两个编号，无法唯一
        const key = img.source ? `${img.source.nodeId}:${img.source.inputName}` : null;
        if (key) {
          for (const [otherIndex, other] of order.images.entries()) {
            if (otherIndex === index) continue;
            const otherKey = other.source ? `${other.source.nodeId}:${other.source.inputName}` : null;
            if (otherKey && otherKey === key) return;
          }
        }
        numbers.set(index, picture);
      }
    });
    if (selectedSlots.some((s) => !numbers.has(s))) return undefined;

    const current = selectedSlots.map((s) => numbers.get(s));
    // 多个消费节点给出的编号必须一致，否则提示词无法同时满足
    if (answer && current.some((n, i) => n !== answer[i])) return undefined;
    answer = current;
  }
  return answer;
}

/** 便捷：直接从图 + 槽位算出编号 */
export function pictureNumbersFor(graph, selectedSlots) {
  return resolvePictureNumbers(readReferenceImageOrders(graph), selectedSlots);
}
