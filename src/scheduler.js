// Time-based jobs. One tick every 20 s; minute-based jobs run once per WITA minute.
import fs from 'node:fs';
import path from 'node:path';
import { wita, witaToUtc, addDays, addMinutesHm } from './time.js';
import { ABSENT } from './rules.js';

export function createScheduler({ presence, db, clockify, out, config, now = () => new Date(), log = console }) {
  let lastMinute = null;
  const timers = [];

  async function safe(name, fn) {
    try { await fn(); } catch (e) { log.error(`[job ${name}]`, e); }
  }

  /** Per-user reminders and the 09:15 "not clocked in" list. */
  async function userJobs(t, w) {
    const missingNow = [];
    for (const u of db.listUsers()) {
      if (!u.clocks_in || !presence.isWorkingDay(u, w.date)) continue;
      const absent = ABSENT.has(db.getStatus(u.discord_id).status) || db.activeAbsence(u.discord_id, w.date);
      if (absent) continue;
      const open = db.getOpenSession(u.discord_id);
      const hadSession = db.latestSessionForDate(u.discord_id, w.date);

      if (w.hm === addMinutesHm(u.work_start, -15) && !open && !hadSession && db.markOnce(`remind-start:${u.discord_id}:${w.date}`)) {
        await out.dm(u.discord_id, `Good morning, ${u.name}. Your day starts at ${u.work_start} — use /clock-in when you begin.`);
      }
      if (w.hm === addMinutesHm(u.work_start, 15) && !hadSession && db.markOnce(`missing:${u.discord_id}:${w.date}`)) {
        missingNow.push(u);
      }
      if (w.hm === addMinutesHm(u.work_end, -15) && open && db.markOnce(`remind-end:${u.discord_id}:${w.date}`)) {
        await out.dm(u.discord_id, `Your day ends at ${u.work_end}. Please update Asana and use /clock-out when you finish.`);
      }
    }
    if (missingNow.length) {
      await out.log(`**Not clocked in yet (${w.hm} WITA):** ${missingNow.map((u) => `${u.name} (${u.team})`).join(', ')}`);
    }
  }

  async function lastActivity(u, s) {
    if (!clockify.enabled || !u.clockify_user_id) return null;
    return clockify.lastActivity(u.clockify_user_id, witaToUtc(s.work_date, '00:00'), now());
  }

  async function weekly(t, w) {
    const toDate = addDays(w.date, -1);          // last Sunday
    const fromDate = addDays(toDate, -6);        // last Monday
    const totals = new Map();
    for (const u of db.listUsers()) {
      if (!u.clockify_user_id) continue;
      try {
        totals.set(u.discord_id, await clockify.userTotalMs(u.clockify_user_id, witaToUtc(fromDate), witaToUtc(addDays(toDate, 1)), t));
      } catch {
        totals.set(u.discord_id, null);
      }
    }
    await out.log(presence.weeklyRecap(fromDate, toDate, clockify.enabled ? totals : new Map()));
  }

  async function backup(w) {
    const dir = config.backupDir;
    db.backupTo(path.join(dir, `presence-${w.date}.db`));
    const files = fs.readdirSync(dir).filter((f) => /^presence-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 14))) fs.rmSync(path.join(dir, f));
    db.pruneKv('claim:', new Date(Date.now() - 7 * 86400000).toISOString());
    db.pruneKv('remind-', new Date(Date.now() - 7 * 86400000).toISOString());
    db.pruneKv('missing:', new Date(Date.now() - 7 * 86400000).toISOString());
    if (w.day === 1) {
      db.backupTo(path.join(dir, `archive-${w.date.slice(0, 7)}.db`));
      db.deleteOlderThan(addDays(w.date, -365));
    }
  }

  async function minuteJobs(t, w) {
    await safe('user', () => userJobs(t, w));
    if (w.hm === '00:05' && db.markOnce(`absences:${w.date}`)) await safe('absences', () => presence.applyAbsences());
    if (w.hm === '21:00' && db.markOnce(`daily:${w.date}`)) await safe('daily', () => out.log(presence.dailyRecap(w.date)));
    if (w.hm === '22:00' && db.markOnce(`autoclose:${w.date}`)) await safe('autoclose', () => presence.autoClose(lastActivity));
    if (w.weekday === 1 && w.hm === '09:00' && db.markOnce(`weekly:${w.date}`)) await safe('weekly', () => weekly(t, w));
    if (w.hm === '02:00' && db.markOnce(`backup:${w.date}`)) await safe('backup', () => backup(w));
  }

  async function tick() {
    const t = now();
    const w = wita(t);
    await safe('meetings', () => presence.expireMeetings());
    const key = `${w.date} ${w.hm}`;
    if (key === lastMinute) return;
    lastMinute = key;
    await minuteJobs(t, w);
  }

  /** Detect /claim from meeting-bot by reading Clockify running timers. */
  async function pollClaims() {
    if (!clockify.enabled) return;
    const t = now();
    const running = await clockify.inProgress();
    for (const e of running) {
      const u = db.getUserByClockify(e.userId);
      if (!u) continue;
      if (!db.markOnce(`claim:${e.id}`)) continue;            // already handled
      const start = new Date(e.timeInterval.start);
      if (t - start > 15 * 60000) continue;                   // old timer (e.g. bot restart) — ignore
      await presence.onClaim(u.discord_id, { at: start, task: e.description || 'task', entryId: e.id });
    }
  }

  return {
    start() {
      timers.push(setInterval(() => safe('tick', tick), 20000));
      timers.push(setInterval(() => safe('claims', pollClaims), config.claimPollSec * 1000));
      safe('tick', tick);
      safe('claims', pollClaims);
    },
    stop() { timers.forEach(clearInterval); },
    // exposed for tests
    tick, pollClaims, minuteJobs,
  };
}
