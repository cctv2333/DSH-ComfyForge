// lib/comfypolling.mjs — 「在场」而不是「整包」，以及「缺席 ≠ 失败」
//
// 两个问题都来自同一个地方：ComfyUI 的 /queue 与 /history 是**权威快照**，
// 但「这一秒没看见」不等于「它失败了」。
//
// 1) /queue 的响应里带着**每一个排队任务的完整工作流**，几 MB。原来 `waitFor`
//    每轮都整包解析一次，长任务要轮询几十轮。这里只留 id 与状态，并按
//    (endpoint, headers) 做 1 秒 TTL —— 同一时刻只发一次读取，其余调用共享它。
//    凭据只作为内存里的缓存键参与比较，**不落盘、不写日志**。
//
// 2) 任务从队列里消失有很多原因：ComfyUI 刚处理完还没写 history、界面重连、
//    队列被清空、我们拿到的快照过期。这些都不是失败。
//    判据（保守）：任务已存在 ≥30 分钟、连续 ≥6 次**有效**观测、跨度 ≥2 分钟。
//    有效 = 快照结构合法；结构不合法的那次观测不计入，也不打断计数。
//
// 教训出处：同类实现在 lianhua-video-director 的 src/comfyPolling.ts
// （`/** Absence is not a generation failure. */`），我们照它的判据重写，
// 但状态由本模块持有，不依赖调用方传时间。

/** 只有在场信息，没有工作流内容 */
export function presenceFromQueue(queue) {
  const pendingOrder = [];
  const pendingIds = new Set();
  const runningIds = new Set();
  const taskIdByClient = new Map();
  let valid = Boolean(queue) && typeof queue === 'object'
    && Array.isArray(queue.queue_pending) && Array.isArray(queue.queue_running);
  if (!valid) return { valid: false, pendingOrder, pendingIds, runningIds, taskIdByClient, observationId: 0 };

  for (const [field, bucket] of [['queue_running', runningIds], ['queue_pending', pendingIds]]) {
    for (const row of queue[field]) {
      // 结构： [number, prompt_id, prompt, extra_data, outputs_to_execute]
      if (!Array.isArray(row) || !['string', 'number'].includes(typeof row[1]) || !String(row[1]).trim()) {
        valid = false;
        continue;
      }
      const id = String(row[1]);
      bucket.add(id);
      if (field === 'queue_pending') pendingOrder.push(id);
      const extra = row[3];
      if (extra && typeof extra === 'object' && typeof extra.client_id === 'string') {
        taskIdByClient.set(extra.client_id, id);
      }
    }
  }
  return { valid, pendingOrder, pendingIds, runningIds, taskIdByClient, observationId: 0 };
}

/**
 * /queue 的在场信息缓存。
 * key 由 endpoint + 请求头构造 —— 不同后端/凭据不能共用同一条缓存。
 */
export class QueuePresenceCache {
  #entries = new Map();
  #nextObservation = 0;

  /** @param {() => Promise<any>} load 真正发请求的函数（通常就是 get('/queue')） */
  get(scope, load, ttlMs = 1000) {
    const now = Date.now();
    const hit = this.#entries.get(scope);
    if (hit && (hit.pending || hit.expiresAt > now)) return hit.value;

    // 过期的条目要清掉：长跑的进程不该无限积累旧的 endpoint/凭据组合
    for (const [key, entry] of this.#entries) {
      if (!entry.pending && entry.expiresAt <= now) this.#entries.delete(key);
    }

    const entry = { expiresAt: 0, pending: true, value: null };
    entry.value = Promise.resolve()
      .then(load)
      .then((queue) => {
        const p = presenceFromQueue(queue);
        p.observationId = ++this.#nextObservation;
        entry.pending = false;
        entry.expiresAt = Date.now() + Math.max(0, ttlMs);
        return p;
      })
      .catch((e) => {
        if (this.#entries.get(scope) === entry) this.#entries.delete(scope);
        throw e;
      });
    this.#entries.set(scope, entry);
    return entry.value;
  }

  clear() { this.#entries.clear(); }
}

/** 缺 30 分钟 + 连续 6 次有效观测 + 跨度 2 分钟，才敢说「它真的不在了」 */
export const MISSING_TASK_POLICY = Object.freeze({
  minimumTaskAgeMs: 30 * 60_000,
  observationWindowMs: 2 * 60_000,
  minimumObservations: 6,
});

/**
 * 记录「某个任务连续多久没被看见」。
 * 状态在模块生命周期内累积（跨多次 waitFor 调用），因为一次调用只有几十秒，
 * 单次窗口内根本凑不满 6 次观测。
 */
export class MissingTaskTracker {
  #missing = new Map();

  /**
   * @param {string} taskId
   * @param {number} firstSeenAt 第一次看到这个任务的时间（≤ 现在）；用来算任务年龄
   * @param {{valid:boolean, observationId:number}} presence
   * @returns {boolean} true = 可以判定「它不在了」，否则继续等
   */
  observe(taskId, firstSeenAt, presence, now = Date.now()) {
    const policy = MISSING_TASK_POLICY;
    // 快照本身不合法，或者任务还年轻：不能下结论，也不打断已有计数
    if (!presence?.valid || !Number.isFinite(firstSeenAt) || firstSeenAt <= 0
      || now - firstSeenAt < policy.minimumTaskAgeMs) {
      this.#missing.delete(taskId);
      return false;
    }
    const prev = this.#missing.get(taskId);
    // 同一份快照被重复观测不能重复计数
    if (prev && prev.observationId === presence.observationId) return false;
    const next = {
      firstAt: prev?.firstAt ?? now,
      observationId: presence.observationId,
      count: (prev?.count ?? 0) + 1,
    };
    this.#missing.set(taskId, next);
    return next.count >= policy.minimumObservations
      && now - next.firstAt >= policy.observationWindowMs;
  }

  /** 又看见了：清零 */
  reset(taskId) { this.#missing.delete(taskId); }

  /** 供测试与诊断 */
  snapshot(taskId) { return this.#missing.get(taskId) ?? null; }

  clear() { this.#missing.clear(); }
}
