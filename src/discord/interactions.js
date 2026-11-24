// Slash command and button handling.
import { MessageFlags } from 'discord.js';
import { wita, witaToUtc, addDays, isDateStr, isHm, fmtDate } from '../time.js';

const PRIVATE = { flags: MessageFlags.Ephemeral };
const CLOCK_COMMANDS = new Set(['clock-in', 'clock-out']);

export function createInteractionHandler({ presence, db, clockify, config, board, log = console }) {
  const hasRole = (i, roleId) => Boolean(roleId) && Boolean(i.member?.roles?.cache?.has(roleId));
  const isAdmin = (i) => hasRole(i, config.roles.admin);
  const isManagement = (i) => isAdmin(i) || hasRole(i, config.roles.management);

  async function reply(i, result) {
    const content = typeof result === 'string' ? result : `${result.ok ? '✔' : '✖'} ${result.message}`;
    if (i.deferred || i.replied) return i.editReply({ content });
    return i.reply({ content, ...PRIVATE });
  }

  async function clockifyTotal(userId, fromDate, toDate) {
    const u = db.getUser(userId);
    if (!clockify.enabled || !u?.clockify_user_id) return undefined;
    try {
      return await clockify.userTotalMs(u.clockify_user_id, witaToUtc(fromDate), witaToUtc(addDays(toDate, 1)));
    } catch (e) {
      log.warn('clockify', e.message);
      return null;
    }
  }

  async function onCommand(i) {
    const name = i.commandName;
    if (CLOCK_COMMANDS.has(name) && i.channelId !== config.channels.employee) {
      return reply(i, { ok: false, message: `Please use /${name} in <#${config.channels.employee}>.` });
    }
    await i.deferReply(PRIVATE);

    switch (name) {
      case 'clock-in':
        return reply(i, await presence.clockIn(i.user.id, { note: i.options.getString('note') }));

      case 'clock-out':
        return reply(i, await presence.clockOut(i.user.id));

      case 'status': {
        if (i.options.getSubcommand() === 'check') {
          const target = i.options.getUser('user', true);
          return reply(i, presence.checkStatus(target.id, { viewerIsManagement: isManagement(i) }).message);
        }
        return reply(i, await presence.setStatus(i.user.id, i.options.getString('value', true), { minutes: i.options.getInteger('minutes') }));
      }

      case 'sick':
        return reply(i, await presence.reportAbsence(i.user.id, 'sick', {
          from: i.options.getString('from'), to: i.options.getString('to'), note: i.options.getString('note'),
        }));

      case 'on-leave':
        return reply(i, await presence.reportAbsence(i.user.id, 'leave', {
          from: i.options.getString('from', true), to: i.options.getString('to', true), note: i.options.getString('note'),
        }));

      case 'myhours': {
        const period = i.options.getString('period') || 'week';
        const today = wita().date;
        let from = today;
        if (period === 'week') from = addDays(today, -(wita().weekday - 1));
        if (period === 'month') from = `${today.slice(0, 7)}-01`;
        const r = presence.myHours(i.user.id, from, today, await clockifyTotal(i.user.id, from, today));
        return reply(i, r.ok ? r.message : r);
      }

      case 'report-attendance':
        if (!isManagement(i)) return reply(i, { ok: false, message: 'Only management can use this command.' });
        return reply(i, presence.attendanceText());

      case 'presence-admin':
        if (!isAdmin(i)) return reply(i, { ok: false, message: 'Only the presence admin can use this command.' });
        return onAdmin(i);

      default:
        return reply(i, { ok: false, message: 'Unknown command.' });
    }
  }

  async function onAdmin(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'fix-session') {
      const date = i.options.getString('date', true);
      const cin = i.options.getString('clock_in');
      const cout = i.options.getString('clock_out');
      if (!isDateStr(date)) return reply(i, { ok: false, message: 'Date must be YYYY-MM-DD.' });
      if ((cin && !isHm(cin)) || (cout && !isHm(cout))) return reply(i, { ok: false, message: 'Times must be HH:MM (WITA).' });
      return reply(i, await presence.adminFixSession(i.options.getUser('user', true).id, { date, clockIn: cin, clockOut: cout }, i.user.id));
    }
    if (sub === 'set-status') {
      return reply(i, await presence.adminSetStatus(i.options.getUser('user', true).id, i.options.getString('value', true), i.user.id));
    }
    if (sub === 'holiday') {
      const date = i.options.getString('date', true);
      if (!isDateStr(date)) return reply(i, { ok: false, message: 'Date must be YYYY-MM-DD.' });
      db.addHoliday(date, i.options.getString('name', true));
      return reply(i, { ok: true, message: `Holiday saved: ${fmtDate(date)}. No reminders that day.` });
    }
    if (sub === 'board') {
      await board.repost();
      return reply(i, { ok: true, message: 'Status board re-posted.' });
    }
    return reply(i, { ok: false, message: 'Unknown admin command.' });
  }

  async function onButton(i) {
    const [kind, action, id] = i.customId.split(':');
    if (kind !== 'absence') return;
    if (!isManagement(i)) return i.reply({ content: '✖ Only management can approve or reject.', ...PRIVATE });
    const r = await presence.decideAbsence(Number(id), action === 'approve', i.user.id);
    if (!r.ok) return i.reply({ content: `✖ ${r.message}`, ...PRIVATE });
    return i.update({ content: `${i.message.content}\n${r.message}`, components: [] });
  }

  return async function handle(i) {
    try {
      if (!config.enabled) {
        if (i.isRepliable()) await i.reply({ content: 'Presence bot is paused at the moment.', ...PRIVATE });
        return;
      }
      if (i.isButton()) return await onButton(i);
      if (i.isChatInputCommand()) return await onCommand(i);
    } catch (e) {
      log.error('interaction', e);
      const msg = { content: '✖ Something went wrong. IT has been notified in the log.' };
      if (i.deferred || i.replied) await i.editReply(msg).catch(() => {});
      else if (i.isRepliable()) await i.reply({ ...msg, ...PRIVATE }).catch(() => {});
    }
  };
}
