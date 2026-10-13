// src/processSub.ts
import type { SaleItem } from './steam.js';
import { fetchTagSpecials, hashSale } from './steam.js';
import { isSeen, markSeen } from './db.js';
import { notifyDiscordBatch, flushTarget } from './notify/index.js';

export type Sub = {
  id: number;
  kind: 'tag';
  tag_id: number;
  notify_webhook: string; // webhook URL (legacy) or channel id (bot mode if extended)
};

export type ProcessOpts = {
  /** Minimum discount %, e.g. 50 means show only -50% or better. Default 0. */
  minDiscount?: number;
  /** Max acceptable final price, e.g. 25 means ≤ 25.00. Default: no cap. */
  maxPrice?: number | null;
  /** Only include games released in/after this year. */
  minYear?: number;
  /** Only include games released in/before this year. */
  maxYear?: number;
  /** Only include games with >= this many total Steam reviews. Default 0 (off). */
  minReviews?: number;
};

/* ---------------- Helpers ---------------- */
function extractPct(text?: string): number | undefined {
  if (!text) return;
  const m = text.match(/-?\s*(\d{1,3})\s*%/);
  if (!m) return;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function getDiscountPct(i: SaleItem): number | undefined {
  if (i.discountPct != null) return i.discountPct;

  const fromText = extractPct(i.discount);
  if (fromText != null) return fromText;

  if (i.priceOld != null && i.priceNew != null && i.priceOld > 0 && i.priceNew <= i.priceOld) {
    const pct = Math.round((1 - i.priceNew / i.priceOld) * 100);
    if (pct >= 0 && pct <= 100) return pct;
  }
  return undefined;
}

function passesMinDiscount(i: SaleItem, min: number): boolean {
  if (min <= 0) return true;
  const pct = getDiscountPct(i);
  return pct === undefined ? true : pct >= min;
}

function passesMaxPrice(i: SaleItem, cap: number | null | undefined): boolean {
  if (cap == null) return true;
  return i.priceNew !== undefined && i.priceNew <= cap;
}

function passesYearRange(i: SaleItem, minYear?: number, maxYear?: number): boolean {
  if (!i.releaseYear) return true; // unknown year => allow
  if (minYear && i.releaseYear < minYear) return false;
  if (maxYear && i.releaseYear > maxYear) return false;
  return true;
}

function passesMinReviews(i: SaleItem, minReviews?: number): boolean {
  const min = Math.max(0, Math.floor(minReviews ?? 0));
  if (min <= 0) return true;
  const count = i.reviewCount ?? 0; // unknown => 0
  return count >= min;
}

/* ---------------- Main entry ---------------- */
export async function processTagSub(sub: Sub, opts?: ProcessOpts) {
  const minDiscount = opts?.minDiscount ?? 0;
  const maxPrice = opts?.maxPrice ?? null;
  const minYear = opts?.minYear;
  const maxYear = opts?.maxYear;
  const minReviews = opts?.minReviews ?? 0;

  const items: SaleItem[] = await fetchTagSpecials(sub.tag_id);

  // Apply all filters
  const filtered = items.filter(
    i =>
      passesMinDiscount(i, minDiscount) &&
      passesMaxPrice(i, maxPrice) &&
      passesYearRange(i, minYear, maxYear) &&
      passesMinReviews(i, minReviews)
  );

  // Deduplicate against seen_sales
  const fresh: SaleItem[] = [];
  for (const it of filtered) {
    const saleHash = hashSale(it);
    if (!isSeen(sub.id, it.appid, saleHash)) {
      // ✅ use plain function (not .run) for consistency with refactor
      markSeen(sub.id, it.appid, saleHash);
      fresh.push(it);
    }
  }

  // Enqueue for notify
  if (fresh.length) {
    notifyDiscordBatch(sub.notify_webhook, fresh);
  }

  return { fetched: items.length, filtered: filtered.length, queued: fresh.length };
}
