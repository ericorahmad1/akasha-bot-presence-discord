// Posting helpers: the `out` object the service uses, plus the pinned status board.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const NO_PINGS = { parse: [] };

export function absenceButtons(absenceId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`absence:approve:${absenceId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`absence:reject:${absenceId}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
  );
}

export function createOut(client, config, log = console) {
  const prefix = config.dryRun ? '[TEST] ' : '';
  const channelCache = new Map();

  async function channel(id) {
    if (!channelCache.has(id)) channelCache.set(id, await client.channels.fetch(id));
    return channelCache.get(id);
  }
  async function send(id, content, extra = {}) {
    const ch = await channel(id);
    return ch.send({ content: prefix + content, allowedMentions: NO_PINGS, ...extra });
  }

  return {
    status: (text) => send(config.channels.employee, text),
    log: (text) => send(config.channels.log, text),
    manage: (text, { absenceId } = {}) => send(config.channels.manage, text, absenceId ? { components: [absenceButtons(absenceId)] } : {}),
    async dm(discordId, text) {
      if (config.dryRun) return send(config.channels.log, `DM to <@${discordId}>: ${text}`);
      try {
        const user = await client.users.fetch(discordId);
        await user.send(text);
      } catch (e) {
        // DMs closed: fall back to a mention in #team-status (pings only that person)
        log.warn(`DM to ${discordId} failed, using channel fallback`, e.message);
        await send(config.channels.employee, `<@${discordId}> ${text}`, { allowedMentions: { users: [discordId] } });
      }
      return null;
    },
  };
}

/** One pinned message in #team-status, edited at most once every 10 s. */
export function createBoard({ client, config, db, render, log = console }) {
  let timer = null;

  async function flush() {
    const ch = await client.channels.fetch(config.channels.employee);
    const content = (config.dryRun ? '[TEST] ' : '') + render();
    const id = db.kvGet('board_message_id');
    const msg = id ? await ch.messages.fetch(id).catch(() => null) : null;
    if (msg) {
      await msg.edit({ content, allowedMentions: NO_PINGS });
      return;
    }
    const created = await ch.send({ content, allowedMentions: NO_PINGS });
    await created.pin().catch((e) => log.warn('Could not pin board (needs Pin/Manage Messages):', e.message));
    db.kvSet('board_message_id', created.id);
  }

  return {
    schedule() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        flush().catch((e) => log.error('board', e));
      }, 10000);
    },
    flush,
    async repost() {
      db.kvSet('board_message_id', '');
      await flush();
    },
  };
}
