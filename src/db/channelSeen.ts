// src/db/channelseen.ts
import { db } from "./connection.js";

/* ---------------- Statements ---------------- */
const stmtCheck = db.prepare<
  [string, number, string],
  { found?: 1 }
>(`
  SELECT 1 as found
  FROM channel_seen_sales
  WHERE channel_id = ? AND appid = ? AND sale_hash = ?
`);

const stmtInsert = db.prepare(`
  INSERT OR IGNORE INTO channel_seen_sales (channel_id, appid, sale_hash)
  VALUES (?, ?, ?)
`);

const stmtClearChannel = db.prepare(`
  DELETE FROM channel_seen_sales
  WHERE channel_id = ?
`);

/* ---------------- API ---------------- */

/** Check if a given sale (appid+hash) has already been posted in this channel. */
export function isChannelSeen(channelId: string, appId: number, hash: string): boolean {
  return !!stmtCheck.get(channelId, appId, hash);
}

/** Mark a sale as seen for a channel to prevent duplicates. */
export function markChannelSeen(channelId: string, appId: number, hash: string) {
  return stmtInsert.run(channelId, appId, hash);
}

/** Clear *all* seen history for a given channel (used by /clearhistory). */
export function clearChannelSeen(channelId: string): number {
  const res = stmtClearChannel.run(channelId);
  return res.changes ?? 0; // number of rows deleted
}
/** Copy existing per-subscription history into channel-level history. */
export function seedChannelSeenFromSubs(): number {
  const result = db.prepare(`
    INSERT OR IGNORE INTO channel_seen_sales (channel_id, appid, sale_hash)
    SELECT s.channel_id, ss.appid, ss.sale_hash
    FROM seen_sales ss
    JOIN subscriptions s ON s.id = ss.sub_id
    WHERE s.channel_id IS NOT NULL
  `).run();

  return result.changes ?? 0;
}
