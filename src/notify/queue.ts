import type { SaleItem, Target, NotifyOptions } from './types.js';
import { EMBED_ITEMS, MAX_QUEUE_PER_TARGET } from './types.js';

type Queued = { item: SaleItem; scope: string | null };
const queue = new Map<string, Queued[]>();

function keyForTarget(target: Target): string {
  return typeof target === 'string' ? `webhook:${target}` : `channel:${target.channelId}`;
}

export function notifyDiscordBatch(target: Target, items: SaleItem[], opts?: NotifyOptions) {
  if (!items?.length) return;

  const key = keyForTarget(target);
  const existing = queue.get(key) ?? [];
  const wrapped: Queued[] = items.map((item) => ({ item, scope: opts?.scope ?? null }));

  const combined: Queued[] = opts?.prepend ? wrapped.concat(existing) : existing.concat(wrapped);

  // Safety cap (keep newest items)
  const overflow = combined.length - MAX_QUEUE_PER_TARGET;
  const trimmed = overflow > 0 ? combined.slice(overflow) : combined;

  queue.set(key, trimmed);
}

/** take up to n items with optional scope-first preference */
function takeFromQueue(key: string, n: number, scope?: string): Queued[] {
  const arr = queue.get(key) ?? [];
  if (arr.length === 0 || n <= 0) return [];

  if (scope == null) {
    const chunk = arr.slice(0, n);
    queue.set(key, arr.slice(chunk.length));
    return chunk;
  }

  const scoped: Queued[] = [];
  const rest: Queued[] = [];
  for (const q of arr) (q.scope === scope ? scoped : rest).push(q);

  const chosen: Queued[] = [];
  while (chosen.length < n && scoped.length) chosen.push(scoped.shift()!);
  while (chosen.length < n && rest.length) chosen.push(rest.shift()!);

  queue.set(key, [...scoped, ...rest]);
  return chosen;
}

export function popBatchForTarget(target: Target, scope?: string): { items: SaleItem[]; remaining: number; key: string; picked: Queued[] } {
  const key = keyForTarget(target);
  const picked = takeFromQueue(key, EMBED_ITEMS, scope);
  const remaining = (queue.get(key) ?? []).length;
  return { items: picked.map(q => q.item), remaining, key, picked };
}

export function forEachTarget(fn: (target: Target) => void | Promise<void>) {
  const keys = Array.from(queue.keys());
  return Promise.all(keys.map(async (key) => {
    const isWebhook = key.startsWith('webhook:');
    const target: Target = isWebhook ? (key.slice(8) as string) : { channelId: key.slice(8) };
    await fn(target);
  }));
}

/** Put a previously picked chunk back at the FRONT on failure (retry next tick). */
export function requeueFront(key: string, picked: Queued[]) {
  const back = queue.get(key) ?? [];
  queue.set(key, picked.concat(back));
}

/** Total number of queued notifications across all targets. */
export function pendingQueueCount(): number {
  let total = 0;

  for (const items of queue.values()) {
    total += items.length;
  }

  return total;
}
