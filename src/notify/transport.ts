import axios from 'axios';
import { buildSingleEmbed } from './format.js';
import type { Target, SaleItem } from './types.js';

async function getClient() {
  const raw: any = await import('../bot.js');
  const mod = raw && typeof raw === 'object' && raw.default && !raw.client ? raw.default : raw;
  const client = mod?.client;
  if (!client) throw new Error('Discord client not found from ./bot.js');
  return client as any;
}

export async function sendToTarget(target: Target, items: SaleItem[]) {
  const embed = buildSingleEmbed(items);

  if (typeof target === 'string') {
    // Webhook mode
    await axios.post(
      target,
      { embeds: [embed.toJSON()] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return;
  }

  // Bot mode
  const client = await getClient();
  const ch = await client.channels.fetch(target.channelId).catch(() => null);

  if (!ch) {
    throw new Error(
      `Discord channel ${target.channelId} not found or bot has no access to it`
    );
  }

  if (
    !(ch as any).isTextBased?.() ||
    typeof (ch as any).send !== 'function'
  ) {
    throw new Error(
      `Discord channel ${target.channelId} does not support messages`
    );
  }

  await (ch as any).send({ embeds: [embed] });
}
