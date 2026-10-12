import { FLUSH_INTERVAL_MS, type Target } from './types.js';
import { forEachTarget, popBatchForTarget, requeueFront } from './queue.js';
import { sendToTarget } from './transport.js';

let interval: NodeJS.Timeout | null = null;

export async function flushTarget(target: Target, opts?: { scope?: string }): Promise<number> {
  const { items, remaining, key, picked } = popBatchForTarget(target, opts?.scope);
  if (!items.length) return 0;

  try {
    await sendToTarget(target, items);
    console.log(`✅ Flushed ${items.length} items to ${typeof target === 'string' ? `webhook:${target}` : `channel:${target.channelId}`} (remaining in queue: ${remaining})`);
    return items.length;
  } catch (e) {
    console.warn(`❌ Failed to flush to ${typeof target === 'string' ? `webhook:${target}` : `channel:${target.channelId}`}:`, e);
    // put the chunk back on failure (retry next tick), matching original behavior
    requeueFront(key, picked);
    return 0;
  }
}

/** Flush ONE embed (up to EMBED_ITEMS items) per target per tick. */
export async function flushQueues(): Promise<number> {
  let total = 0;

  await forEachTarget(async (target) => {
    total += await flushTarget(target);
  });

  return total;

}


/** Explicitly start periodic flushing (no side-effects on import). */
export function startNotifyTimer(periodMs = FLUSH_INTERVAL_MS) {
  if (interval) return;
  interval = setInterval(() => { void flushQueues(); }, periodMs);
}

/** Stop the periodic flushing. */
export function stopNotifyTimer() {
  if (!interval) return;
  clearInterval(interval);
  interval = null;
}
