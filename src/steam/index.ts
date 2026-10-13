import crypto from 'crypto';
import type { SaleItem } from './types.js';
export type { SaleItem } from './types.js';

import { fetchResultsHtml } from './fetch.js';
import { parseResultsHtml } from './parse.js';

/* ========== Hash helper ========== */
export function hashSale(item: SaleItem) {
  const discount =
    item.discountPct !== undefined
      ? String(item.discountPct)
      : (item.discount || '').replace(/\s+/g, '').replace(',', '.');

  const price =
    item.priceNew !== undefined
      ? Number(item.priceNew).toFixed(2)
      : (item.price || '').replace(/\s+/g, ' ').trim();

  const currency = (item.currency || '').trim().toUpperCase();

  return crypto
    .createHash('sha256')
    .update(`${item.appid}|${discount}|${price}|${currency}`)
    .digest('hex');
}

/* ========== Main ========== */
export async function fetchTagSpecials(
  tagId: number,
  start = 0,
  count = 50
): Promise<SaleItem[]> {
  const html = await fetchResultsHtml(tagId, start, count);
  if (!html) return [];
  return parseResultsHtml(html);
}
