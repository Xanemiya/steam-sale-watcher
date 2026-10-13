// src/discord/handlers/subscriptions.ts
import type { ChatInputCommandInteraction } from 'discord.js';

import {
  db,
  insertUserSub,
  deleteUserSub,
  listUserSubs,
  isSeen,
  markSeen,
  isChannelSeen,
  markChannelSeen,
  getChannelMinDiscount as dbGetMin,
  getChannelMaxPrice as dbGetMax,
  getChannelMinYear as dbGetMinYear,
  getChannelMaxYear as dbGetMaxYear,
  getChannelMinReviews as dbGetMinReviews,
} from '../../db.js';

import { fetchTagSpecials, hashSale, type SaleItem } from '../../steam.js';
import { notifyDiscordBatch, flushTarget } from '../../notify/index.js';
import { EPHEMERAL, safeReply } from '../reply.js';
import {
  resolveTag,
  passesMinDiscount,
  passesMaxPrice,
  passesYearRange,
  passesMinReviews,
} from '../filters.js';
import { TAG_NAME_TO_ID } from '../../tagsMap.js';
import { scheduleSnapshot } from '../../db/state.js';

/** Look up (or create) the subscription row id for this triplet. */
function getOrCreateSubId(opts: {
  tag_id: number;
  guild_id: string;
  channel_id: string;
  user_id: string;
}): number {
  insertUserSub.run({
    kind: 'tag',
    tag_id: opts.tag_id,
    guild_id: opts.guild_id,
    channel_id: opts.channel_id,
    user_id: opts.user_id,
  });

  const row = db
    .prepare(
      `SELECT id FROM subscriptions
       WHERE kind='tag'
         AND tag_id=@tag_id
         AND guild_id=@guild_id
         AND channel_id=@channel_id
         AND user_id=@user_id
       LIMIT 1`
    )
    .get(opts) as { id?: number } | undefined;

  if (!row?.id && row?.id !== 0) {
    throw new Error('Failed to resolve subscription id after insert.');
  }
  return row.id!;
}

/** tiny helper: followUp without throwing if already closed */
async function safeFollowUp(
  inter: ChatInputCommandInteraction,
  data: { content: string; flags?: number }
) {
  try {
    await inter.followUp(data);
  } catch {
    /* noop */
  }
}

export async function handleSubscribe(inter: ChatInputCommandInteraction) {
  const guildId = inter.guildId!;
  const channelId = inter.channelId!;
  const userId = inter.user.id;

  const raw = inter.options.getString('genre', true);
  const res = resolveTag(raw);
  if (!res) {
    return safeReply(inter, {
      content: `❌ Unknown genre/tag: \`${raw}\``,
      flags: EPHEMERAL,
    });
  }

  const subId = getOrCreateSubId({
    tag_id: res.id,
    guild_id: guildId,
    channel_id: channelId,
    user_id: userId,
  });

  await safeReply(inter, {
    content: `✅ Subscribed **${res.label}** (tag ${res.id}) in this channel.\n🔎 Fetching some deals for you now…`,
  });

  try {
    const fetched = await fetchTagSpecials(res.id, 0, 50);

    const minDisc = dbGetMin(channelId);
    const maxPrice = dbGetMax(channelId);
    const minYear = dbGetMinYear(channelId);
    const maxYear = dbGetMaxYear(channelId);
    const minReviews = dbGetMinReviews(channelId);

    const filtered = fetched.filter(
      (i) =>
        passesMinDiscount(i, minDisc) &&
        passesMaxPrice(i, maxPrice) &&
        passesYearRange(i, minYear, maxYear) &&
        passesMinReviews(i, minReviews)
    );

    const fresh: SaleItem[] = [];
    for (const it of filtered) {
      const h = hashSale(it);
      if (!isSeen(subId, it.appid, h) && !isChannelSeen(channelId, it.appid, h)) {
        markSeen(subId, it.appid, h);
        markChannelSeen(channelId, it.appid, h);
        fresh.push(it);
      }
    }

    if (fresh.length) {
      notifyDiscordBatch({ channelId }, fresh, { prepend: true });
      await flushTarget({ channelId });
      return;
    }

    const lines: string[] = [
      `🙇 No new deals to post **right now** for tag **${res.id}**.`,
      `• fetched: **${fetched.length}**`,
      `• matched filters: **${filtered.length}**`,
      `• new (not previously posted): **0**`,
    ];

    if (fetched.length === 0) {
      lines.push(
        `\nThis tag currently has no specials. It can happen between sale waves — I’ll post when Steam updates.`
      );
    } else if (filtered.length === 0) {
      lines.push(
        `\nYour filters are likely too strict. Try:`,
        `• \`/setmindiscount\` — lower the %`,
        `• \`/setmaxprice\` or \`/clearmaxprice\``,
        `• \`/setminreviews\` — lower the minimum`,
        `• \`/clearyears\` — if year filters are too tight`
      );
    } else {
      lines.push(
        `\nEverything that matched your filters was already posted earlier.`,
        `New deals will appear automatically as Steam rotates specials.`
      );
    }

    await safeFollowUp(inter, { content: lines.join('\n'), flags: EPHEMERAL });
  } catch (err) {
    console.warn(`⚠️ Immediate fetch failed for tag ${res.id}`, err);
    await safeFollowUp(inter, {
      content: `⚠️ Couldn't fetch deals right now (Steam may be throttling). I’ll try again on the next cycle.`,
      flags: EPHEMERAL,
    });
  }
}

export async function handleUnsubscribe(inter: ChatInputCommandInteraction) {
  const guildId = inter.guildId!;
  const channelId = inter.channelId!;
  const userId = inter.user.id;

  const raw = inter.options.getString('genre', true);
  const res = resolveTag(raw);
  if (!res) {
    return safeReply(inter, {
      content: `❌ Unknown genre/tag: \`${raw}\``,
      flags: EPHEMERAL,
    });
  }

  deleteUserSub.run({
    kind: 'tag',
    tag_id: res.id,
    guild_id: guildId,
    channel_id: channelId,
    user_id: userId,
  });

  return safeReply(inter, {
    content: `🗑️ Unsubscribed **${res.label}** (tag ${res.id}) in this channel.`,
  });
}

export async function handleUnsubscribeAll(inter: ChatInputCommandInteraction) {
  const guildId = inter.guildId!;
  const channelId = inter.channelId!;
  const userId = inter.user.id;

  const res = db
    .prepare(
      `DELETE FROM subscriptions
       WHERE kind='tag'
         AND guild_id=@guild_id
         AND channel_id=@channel_id
         AND user_id=@user_id`
    )
    .run({ guild_id: guildId, channel_id: channelId, user_id: userId });

  // ✅ schedule snapshot exactly once, only when something changed
  const deleted = res?.changes ?? 0;
  if (deleted > 0) {
    scheduleSnapshot();
  }

  return safeReply(inter, {
    content: `🗑️ Unsubscribed from **all tags** in this channel.`,
    flags: EPHEMERAL,
  });
}

export async function handleList(inter: ChatInputCommandInteraction) {
  const rows = listUserSubs.all({
    guild_id: inter.guildId!,
    channel_id: inter.channelId!,
    user_id: inter.user.id,
  }) as Array<{ tag_id: number }>;

  if (rows.length === 0) {
    return safeReply(inter, {
      content: '📭 You have no subscriptions in this channel.',
      flags: EPHEMERAL,
    });
  }

  const idToName = new Map<number, string>();
  for (const [name, id] of TAG_NAME_TO_ID.entries()) {
    if (!idToName.has(id)) idToName.set(id, name);
  }

  const body = rows
    .map((r) => {
      const name = idToName.get(r.tag_id);
      return name ? `• ${name} (tag ${r.tag_id})` : `• tag ${r.tag_id}`;
    })
    .join('\n');

  return safeReply(inter, {
    content: `📜 Your subs here:\n${body}`,
    flags: EPHEMERAL,
  });
}
