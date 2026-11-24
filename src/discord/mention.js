// Polite auto-reply when someone mentions a person who is Offline, Sick, On-Leave or On-Meeting.
export function createMentionHandler({ presence, config, log = console }) {
  const lastReply = new Map(); // `${channelId}:${userId}` -> timestamp

  return async function onMessage(message) {
    try {
      if (!config.enabled || !config.mentionAutoReply) return;
      if (message.author.bot || !message.inGuild()) return;
      if ([config.channels.manage, config.channels.log].includes(message.channelId)) return;

      for (const target of message.mentions.users.values()) {
        if (target.bot || target.id === message.author.id) continue;
        const text = presence.mentionReply(target.id);
        if (!text) continue;

        const key = `${message.channelId}:${target.id}`;
        const now = Date.now();
        if (now - (lastReply.get(key) || 0) < config.mentionCooldownMin * 60000) continue;
        lastReply.set(key, now);

        const sent = await message.reply({
          content: (config.dryRun ? '[TEST] ' : '') + text,
          allowedMentions: { parse: [], repliedUser: false }, // never pings the absent person or management
        });
        if (config.mentionDeleteAfterMin > 0) {
          setTimeout(() => sent.delete().catch(() => {}), config.mentionDeleteAfterMin * 60000);
        }
      }
    } catch (e) {
      log.error('mention', e);
    }
  };
}
