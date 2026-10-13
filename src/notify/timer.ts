import { FLUSH_INTERVAL_MS, type Target } from './types.js';
import {
  forEachTarget,
  popBatchForTarget,
  requeueFront,
  pendingQueueCount,
} from './queue.js';
import { sendToTarget } from './transport.js';

let interval: NodeJS.Timeout | null = null;

export async function flushTarget(
  target: Target,
  opts?: { scope?: string },
): Promise<number> {
  const { items, remaining, key, picked } = popBatchForTarget(target, opts?.scope);
  if (!items.length) return 0;

  const targetName =
    typeof target === 'string'
      ? `webhook:${target}`
      : `channel:${target.channelId}`;

  try {
    await sendToTarget(target, items);
    console.log(
      `✅ Flushed ${items.length} items to ${targetName} (remaining in queue: ${remaining})`,
    );
    return items.length;
  } catch (e) {
    console.warn(`❌ Failed to flush to ${targetName}:`, e);
    requeueFront(key, picked);
    return 0;
  }
}

/**
 * Flush all queued batches. Stop with an error if the queue cannot drain.
 */
export async function flushQueues(): Promise<number> {
  let total = 0;
  const maxRounds = 20;

  for (let round = 1; round <= maxRounds; round++) {
    const before = pendingQueueCount();
    if (before === 0) {
      console.log(`✅ Notification queue empty. Sent ${total} items.`);
      return total;
    }

    let sentThisRound = 0;

    await forEachTarget(async (target) => {
      sentThisRound += await flushTarget(target);
    });

    total += sentThisRound;

    const after = pendingQueueCount();

    if (after === 0) {
      console.log(`✅ Notification queue drained. Sent ${total} items.`);
      return total;
    }

    if (after >= before || sentThisRound === 0) {
      throw new Error(
        `Notification queue did not drain: ${after} items remain. ` +
        'At least one send failed; check the Discord errors above.',
      );
    }

    console.log(
      `🔄 Queue flush round ${round}/${maxRounds}: ${after} items remain.`,
    );
  }

  throw new Error(
    `Notification queue still has ${pendingQueueCount()} items after ${maxRounds} rounds.`,
  );
}

/** Explicitly start periodic flushing (no side-effects on import). */
export function startNotifyTimer(periodMs = FLUSH_INTERVAL_MS) {
  if (interval) return;

  interval = setInterval(() => {
    void flushQueues().catch((error) => {
      console.error('❌ Periodic notification flush failed:', error);
    });
  }, periodMs);
}

/** Stop the periodic flushing. */
export function stopNotifyTimer() {
  if (!interval) return;
  clearInterval(interval);
  interval = null;
}
