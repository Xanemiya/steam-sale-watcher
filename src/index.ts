// src/index.ts

// Optional if you already run Node with --env-file=.env;
// keeping it is fine and harmless.
import 'dotenv/config';

import type { SaleItem } from './steam.js';
import { fetchTagSpecials, hashSale } from './steam.js';

import {
  db,
  insertSub,
  listSubs,
  isSeen,
  markSeen,
  listAllChannelSubs,
  listDistinctChannels,
  getChannelMinReviews,
  isChannelSeen,
  markChannelSeen,
  seedChannelSeenFromSubs,
} from './db.js';

import { notifyDiscordBatch, flushQueues } from './notify/index.js';
import { passesMinReviews } from './discord/filters.js';

/* =========================
   Runtime wiring (bot/legacy)
   ========================= */
let startBot: (() => Promise<void>) | undefined;
let getChannelMinDiscount: ((channelId: string) => number) | undefined;
let getChannelMaxPrice: ((channelId: string) => number | null) | undefined;
let getChannelMinYear: ((channelId: string) => number | null) | undefined;
let getChannelMaxYear: ((channelId: string) => number | null) | undefined;

const POLL = Number(process.env.POLL_SECONDS || 600);
const BATCH = Number(process.env.TAG_BATCH || 10);
const REQ_DELAY_MS = Number(process.env.REQ_DELAY_MS || 400);

const MIN_DISC_LEGACY = Number(process.env.MIN_DISCOUNT || 0);
const MAX_PRICE_LEGACY =
  process.env.MAX_PRICE != null && process.env.MAX_PRICE !== ''
    ? Number(process.env.MAX_PRICE)
    : null;

const MODE_BOT = !!process.env.DISCORD_TOKEN;
console.log(`Mode: ${MODE_BOT ? 'Discord Bot (slash commands)' : 'Legacy Webhook'}`);

/* =========================
   Utils
   ========================= */
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

const pctNumber = (text?: string): number | undefined => {
  if (!text) return;
  const m = text.match(/-?\s*(\d{1,3})\s*%/);
  return m ? Number(m[1]) : undefined;
};

const passesMaxPrice = (item: SaleItem, cap: number | null): boolean =>
  cap == null ? true : item.priceNew !== undefined && item.priceNew <= cap;

const passesMinDiscount = (item: SaleItem, minPct: number): boolean => {
  if (minPct <= 0) return true;
  const parsed = item.discountPct ?? pctNumber(item.discount);
  return parsed === undefined ? true : parsed >= minPct;
};

const passesYearRange = (
  item: SaleItem,
  minYear?: number | null,
  maxYear?: number | null
): boolean => {
  if (!item.releaseYear) return true;
  if (minYear && item.releaseYear < minYear) return false;
  if (maxYear && item.releaseYear > maxYear) return false;
  return true;
};

const logBatch = (
  scope: string,
  tagId: number,
  fetched: number,
  filtered: number,
  fresh: number
) => {
  console.log(
    `📦 [${scope}] tag ${tagId}: fetched=${fetched} filtered=${filtered} fresh=${fresh}`
  );
};

/* =========================
   Legacy mode
   ========================= */
type Tag = { id: number; name: string };
let legacyCursor = 0;

async function maybeLegacySeed() {
  if (MODE_BOT || !process.env.DISCORD_WEBHOOK) return;
  if (listSubs().length > 0) return;

  const tagsModule = await import('./tags.json', { assert: { type: 'json' } } as any);
  const tagList = (tagsModule.default as Tag[]) ?? [];

  tagList.forEach((tag, i) =>
    insertSub.run({
      id: i + 1,
      kind: 'tag',
      tag_id: tag.id,
      company: null,
      notify_webhook: process.env.DISCORD_WEBHOOK!,
    })
  );

  console.log(`🌱 Seeded ${tagList.length} tag subscriptions from tags.json (legacy mode)`);
}

async function tickLegacy() {
  const subs = listSubs().filter((s) => s.kind === 'tag' && s.tag_id && s.notify_webhook);
  if (!subs.length) {
    console.log('⚠️ No legacy subscriptions configured.');
    return;
  }

  const slice = subs.slice(legacyCursor, legacyCursor + BATCH);
  legacyCursor = (legacyCursor + BATCH) % subs.length;

  for (const sub of slice) {
    try {
      const items = await fetchTagSpecials(sub.tag_id!);
      const filtered = items.filter(
        (i) =>
          passesMinDiscount(i, MIN_DISC_LEGACY) &&
          passesMaxPrice(i, MAX_PRICE_LEGACY) &&
          passesMinReviews(i, 0) // default reviews filter
      );

      const fresh: SaleItem[] = [];
      for (const it of filtered) {
        const saleHash = hashSale(it);
        if (!isSeen(sub.id!, it.appid, saleHash)) {
          markSeen(sub.id!, it.appid, saleHash);
          fresh.push(it);
        }
      }

      logBatch('legacy', sub.tag_id ?? 0, items.length, filtered.length, fresh.length);
      if (fresh.length && sub.notify_webhook) {
        notifyDiscordBatch(sub.notify_webhook, fresh);
      }

      if (REQ_DELAY_MS > 0) await sleep(REQ_DELAY_MS);
    } catch (e: any) {
      console.error(`❌ [legacy] sub ${sub.id} failed:`, e?.stack || e);
    }
  }
}

/* =========================
   Bot mode
   ========================= */


async function maybeStartBot() {
  const raw: any = await import('./bot.js').catch((e) => {
    console.error('❌ Failed to import bot.js:', e);
    throw e;
  });

  const bot = raw?.default && !raw.startBot ? raw.default : raw;
  startBot = bot.startBot;
  getChannelMinDiscount = bot.getChannelMinDiscount;
  getChannelMaxPrice = bot.getChannelMaxPrice;
  getChannelMinYear = bot.getChannelMinYear;
  getChannelMaxYear = bot.getChannelMaxYear;

  if (typeof startBot !== 'function') throw new Error('startBot not exported from ./bot.js');
  await startBot();
}

async function tickBot() {
  seedChannelSeenFromSubs();

  const seenSalesCount = (
    db.prepare('SELECT COUNT(*) AS count FROM seen_sales').get() as { count: number }
  ).count;

  const channelSeenCount = (
    db.prepare('SELECT COUNT(*) AS count FROM channel_seen_sales').get() as { count: number }
  ).count;

  console.log(
    `🧾 Deduplication database counts: seen_sales=${seenSalesCount}, channel_seen_sales=${channelSeenCount}`,
  );

  const channels = listDistinctChannels();
  if (!channels.length) {
    console.log('⚠️ No user subscriptions yet.');
    return;
  }

  for (const { channel_id } of channels) {
    const subs = listAllChannelSubs.all({ channel_id }) as any[];
    if (!subs.length) continue;

    const minDisc = getChannelMinDiscount?.(channel_id) ?? 0;
    const maxPrice = getChannelMaxPrice?.(channel_id) ?? null;
    const minYear = getChannelMinYear?.(channel_id) ?? null;
    const maxYear = getChannelMaxYear?.(channel_id) ?? null;
    const minReviews = getChannelMinReviews?.(channel_id) ?? 0;

    const slice = subs;

    for (const sub of slice) {
      try {
        const items = await fetchTagSpecials(sub.tag_id);
        const filtered = items.filter(
          (i) =>
            passesMinDiscount(i, minDisc) &&
            passesMaxPrice(i, maxPrice) &&
            passesYearRange(i, minYear, maxYear) &&
            passesMinReviews(i, minReviews)
        );

        const fresh: SaleItem[] = [];
        for (const it of filtered) {
          const h = hashSale(it);

          if (!isChannelSeen(channel_id, it.appid, h)) {
            markChannelSeen(channel_id, it.appid, h);
            markSeen(sub.id, it.appid, h);
            fresh.push(it);
          }
        }

        logBatch(`bot #${channel_id}`, sub.tag_id, items.length, filtered.length, fresh.length);
        if (fresh.length) {
          notifyDiscordBatch({ channelId: channel_id }, fresh);
        }

        if (REQ_DELAY_MS > 0) await sleep(REQ_DELAY_MS);
      } catch (e: any) {
        console.error(`❌ [bot] #${channel_id} tag ${sub.tag_id} failed:`, e?.stack || e);
      }
    }
  }
}

/* =========================
   MAIN
   ========================= */
(async () => {
  let botClient: any = null;
  let dbRef: any = null;
  let exitCode = 0;

  try {
    if (MODE_BOT) {
      // Import once, keep the client reference for reliable cleanup.
      const botModule: any = await import('./bot.js');
      botClient = botModule.client ?? botModule.default?.client;

      await maybeStartBot();
      await tickBot();
    } else {
      await maybeLegacySeed();
      await tickLegacy();
    }

    // Send every queued batch before exiting.
    const sent = await flushQueues();
    console.log(`📨 Notification flush completed: ${sent} items sent.`);

    // Checkpoint the SQLite WAL only after successful processing and sending.
    const dbModule = await import('./db.js');
    dbRef = dbModule.db;
    dbRef.pragma('wal_checkpoint(TRUNCATE)');

    console.log('✅ One-shot run completed.');
  } catch (err: unknown) {
    console.error('❌ Fatal run error:', err);
    exitCode = 1;
  } finally {
    // Always attempt to stop the Discord client.
    try {
      if (botClient) {
        botClient.destroy();
        console.log('🔌 Discord client closed.');
      }
    } catch (e) {
      console.error('⚠️ Failed to close Discord client:', e);
      exitCode = 1;
    }

    // Close SQLite even when processing or sending fails.
    try {
      if (!dbRef) {
        const dbModule = await import('./db.js');
        dbRef = dbModule.db;
      }

      if (dbRef?.open) {
        dbRef.close();
        console.log('🗄️ SQLite database closed.');
      }
    } catch (e) {
      console.error('⚠️ Failed to close SQLite database:', e);
      exitCode = 1;
    }

    process.exitCode = exitCode;
  }
})();

/* =========================
   Global safety nets
   ========================= */
process.on('unhandledRejection', (reason: any, p) => {
  console.error('❌ Unhandled Rejection at:', p);
  if (reason instanceof Error) {
    console.error(reason.stack || reason.message);
  } else {
    console.error('Non-Error rejection:', reason);
    try {
      console.error('As JSON:', JSON.stringify(reason));
    } catch {}
  }
});

process.on('uncaughtException', (err: any) => {
  console.error('❌ Uncaught Exception:');
  if (err instanceof Error) {
    console.error(err.stack || err.message);
  } else {
    console.error('Non-Error thrown:', err);
  }
});
