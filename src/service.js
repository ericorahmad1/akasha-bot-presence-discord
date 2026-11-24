// Business logic. Talks to the database and to an `out` object for posting.
// `out` = { status(text), manage(text, {absenceId}?), log(text), dm(discordId, text) } — all async.
import { S, WORKING, ABSENT, NOT_AVAILABLE, decide } from './rules.js';
import { wita, witaToUtc, addDays, weekdayOf, fmtDate, fmtDay, duration, hm, isDateStr, daysBetween, stamp } from './time.js';
import { post, logLine, checkText, mentionText, statusLine, managementRef, LABEL } from './format.js';

const okr = (message, extra = {}) => ({ ok: true, message, ...extra });
const fail = (message) => ({ ok: false, message });

export class Presence {
  constructor({ db, out, config, now = () => new Date(), onChange = () => {} }) {
    this.db = db;
    this.out = out;
    this.config = config;
    this.now = now;
    this.onChange = onChange;
  }

  // ---------- helpers ----------
  user(id) {
    const u = this.db.getUser(id);
    return u && u.active ? u : null;
  }

  isWorkingDay(user, date) {
    const days = String(user.work_days).split(',').map((d) => Number(d.trim()));
    return days.includes(weekdayOf(date)) && !this.db.isHoliday(date);
  }

  /** Next day (from `date`, inclusive) that is a working day and not covered by an absence. */
  nextWorkingDate(user, date, inclusive = true) {
    let d = inclusive ? date : addDays(date, 1);
    for (let i = 0; i < 60; i += 1) {
      if (this.isWorkingDay(user, d) && !this.db.activeAbsence(user.discord_id, d)) return d;
      d = addDays(d, 1);
    }
    return d;
  }

  /** "today from 09:00 WITA" / "on Tue 24 Nov from 09:00 WITA" */
  nextWindow(user, at = this.now()) {
    const w = wita(at);
    const today = w.date;
    if (this.isWorkingDay(user, today) && !this.db.activeAbsence(user.discord_id, today)) {
      if (w.hm < user.work_start) return `today from ${user.work_start} WITA`;
      if (w.hm < user.work_end && !this.db.latestSessionForDate(user.discord_id, today)) return 'later today (not clocked in yet)';
    }
    const d = this.nextWorkingDate(user, today, false);
    return `on ${fmtDay(d)} from ${user.work_start} WITA`;
  }

  _setStatus(user, next, { at, source, ref = null, expiresAt = null, detail = null }) {
    const prev = this.db.getStatus(user.discord_id).status;
    this.db.setStatus(user.discord_id, next, { at: at.toISOString(), expiresAt, detail });
    this.db.addEvent({ discordId: user.discord_id, status: next, prev, source, at: at.toISOString(), ref });
    this.onChange();
    return prev;
  }

  // ---------- clock in / out ----------
  async clockIn(id, { note = null, source = 'command' } = {}) {
    const u = this.user(id);
    if (!u) return fail('You are not on the presence roster yet. Please contact IT.');
    if (!u.clocks_in) return fail('Your account is not set up to clock in.');
    const at = this.now();
    const open = this.db.getOpenSession(id);
    const cur = this.db.getStatus(id).status;
    if (open) return fail(`You are already online since ${hm(open.clock_in)} WITA.`);
    const d = decide(cur, { type: 'clock_in' }, { hasOpenSession: false });
    if (!d.ok) return fail(d.reason);
    if (note && note.length > 80) return fail('Note is too long (max 80 characters).');

    this.db.transaction(() => {
      this.db.openSession({ discordId: id, workDate: wita(at).date, at: at.toISOString(), source, note });
      this._setStatus(u, S.ONLINE, { at, source });
    });
    await this.out.status(post(u, at, S.ONLINE));
    await this.out.log(logLine(u, at, 'clock in', note ? `note: ${note}` : `source: ${source}`));
    return okr(`You are clocked in at ${hm(at)} WITA. Have a productive day.`);
  }

  async clockOut(id, { source = 'command' } = {}) {
    const u = this.user(id);
    if (!u) return fail('You are not on the presence roster yet. Please contact IT.');
    const at = this.now();
    const open = this.db.getOpenSession(id);
    const cur = this.db.getStatus(id).status;
    const d = decide(cur, { type: 'clock_out' }, { hasOpenSession: !!open });

    if (!open) {
      await this.out.log(logLine(u, at, 'clock out without clock-in', 'flag: no clock-in record'));
      if (d.next !== cur) this._setStatus(u, d.next, { at, source });
      return okr('No open session was found. Your clock-out was recorded with the flag "no clock-in record" (no hours counted).');
    }
    const closed = this.db.transaction(() => {
      const s = this.db.closeSession(open.id, { at: at.toISOString(), source });
      if (d.next !== cur) this._setStatus(u, d.next, { at, source });
      return s;
    });
    const workedMs = new Date(closed.clock_out) - new Date(closed.clock_in);
    await this.out.status(post(u, at, S.OFFLINE, { workedMs }));
    await this.out.log(logLine(u, at, 'clock out', `${hm(closed.clock_in)}–${hm(at)} · ${duration(workedMs)}`));
    return okr(`You are clocked out at ${hm(at)} WITA · worked ${duration(workedMs)}. Thank you!`);
  }

  // ---------- status ----------
  async setStatus(id, value, { minutes = null, source = 'command' } = {}) {
    const u = this.user(id);
    if (!u) return fail('You are not on the presence roster yet. Please contact IT.');
    const at = this.now();
    const cur = this.db.getStatus(id).status;
    const open = this.db.getOpenSession(id);
    const d = decide(cur, { type: 'set', value }, { hasOpenSession: !!open });
    if (!d.ok) return fail(d.reason);
    if (d.noop) return okr(`Your status is already ${LABEL[cur]}.`);

    let expiresAt = null;
    let mins = null;
    if (value === S.ON_MEETING) {
      mins = Math.min(Math.max(Number(minutes) || this.config.meetingDefaultMin, 5), 240);
      expiresAt = new Date(at.getTime() + mins * 60000).toISOString();
    }
    this._setStatus(u, value, { at, source, expiresAt, detail: mins ? String(mins) : null });
    await this.out.status(post(u, at, value, { minutes: mins }));
    await this.out.log(logLine(u, at, `status ${LABEL[cur]} → ${LABEL[value]}`));
    if (value === S.ON_MEETING) return okr(`Status set to On-Meeting until about ${hm(expiresAt)} WITA. You will be set back to Online automatically.`);
    return okr(`Status set to ${LABEL[value]}.`);
  }

  checkStatus(targetId, { viewerIsManagement = false } = {}) {
    const u = this.user(targetId);
    if (!u) return fail('This person is not on the presence roster.');
    const st = this.db.getStatus(targetId);
    const absence = ABSENT.has(st.status) ? this.db.activeAbsence(targetId, wita(this.now()).date) : null;
    return okr(checkText(u, st, {
      showAbsenceType: viewerIsManagement,
      backOn: absence ? this.nextWorkingDate(u, absence.end_date, false) : null,
      nextWindow: this.nextWindow(u),
    }));
  }

  /** Text for the public auto-reply when `id` is mentioned, or null if no reply is needed. */
  mentionReply(id) {
    const u = this.user(id);
    if (!u) return null;
    const st = this.db.getStatus(id);
    if (!NOT_AVAILABLE.has(st.status)) return null;
    return mentionText(u, st, {
      management: managementRef(this.config.roles?.management),
      nextWindow: this.nextWindow(u),
    });
  }

  // ---------- claim (detected from Clockify) ----------
  async onClaim(id, { at = this.now(), task = 'task', entryId = null } = {}) {
    const u = this.user(id);
    if (!u) return null;
    const cur = this.db.getStatus(id).status;
    const open = this.db.getOpenSession(id);
    const d = decide(cur, { type: 'claim' }, { hasOpenSession: !!open, autoClockInOnClaim: this.config.autoClockInOnClaim });
    const ref = entryId ? `clockify:${entryId}` : null;

    if (d.notifyManagement) {
      await this.out.manage(`${logLine(u, at, `task claimed while ${LABEL[cur]}`, task)}\nPlease check with ${u.name}; status stays ${LABEL[cur]}.`);
      await this.out.log(logLine(u, at, 'claim during absence', task));
      return d;
    }
    if (d.openSession) {
      this.db.transaction(() => {
        this.db.openSession({ discordId: id, workDate: wita(at).date, at: at.toISOString(), source: 'claim', flags: d.flag });
        this._setStatus(u, S.ONLINE, { at, source: 'claim', ref });
      });
      await this.out.status(post(u, at, S.ONLINE, { task }));
      await this.out.log(logLine(u, at, 'auto clock-in via claim', task));
      return d;
    }
    if (d.noop || d.next === cur) {
      await this.out.log(logLine(u, at, 'claim', task));
      return d;
    }
    this._setStatus(u, S.ONLINE, { at, source: 'claim', ref });
    await this.out.status(post(u, at, S.ONLINE, { task }));
    await this.out.log(logLine(u, at, `claim · ${LABEL[cur]} → Online`, task));
    return d;
  }

  // ---------- sick / leave ----------
  _validateRange(from, to) {
    if (!isDateStr(from) || !isDateStr(to)) return 'Dates must use the format YYYY-MM-DD, e.g. 2026-11-25.';
    if (to < from) return 'The end date is before the start date.';
    if (daysBetween(from, to) > 30) return 'Please keep one request to 31 days or less.';
    return null;
  }

  async reportAbsence(id, kind, { from = null, to = null, note = null } = {}) {
    const u = this.user(id);
    if (!u) return fail('You are not on the presence roster yet. Please contact IT.');
    const at = this.now();
    const today = wita(at).date;
    const start = from || today;
    const end = to || start;
    const err = this._validateRange(start, end);
    if (err) return fail(err);
    if (end < today) return fail('That period is already in the past. Ask management to record it.');
    if (note && note.length > 80) return fail('Note is too long (max 80 characters).');

    const policy = kind === 'sick' ? this.config.policy.sick : this.config.policy.leave;
    const word = kind === 'sick' ? 'Sick report' : 'Leave request';
    const days = daysBetween(start, end) + 1;
    const period = start === end ? fmtDate(start) : `${fmtDate(start)} – ${fmtDate(end)}`;
    const head = `[${stamp(at)}] — ${u.name} — ${u.team}`;

    if (policy === 'B') {
      const aid = this.db.createAbsence({ discordId: id, kind, start, end, note, state: 'declared', at: at.toISOString() });
      await this.out.manage(`${head}\n${word}: ${period} (${days} day${days > 1 ? 's' : ''}) · Policy B: status set${start <= today ? ' immediately' : ` on ${fmtDate(start)}`}`);
      if (start <= today) await this._startAbsence(u, this.db.getAbsence(aid), at);
      return okr(`${word} recorded for ${period}. Management has been notified.${kind === 'sick' ? ' Get well soon.' : ''}`);
    }
    const aid = this.db.createAbsence({ discordId: id, kind, start, end, note, state: 'requested', at: at.toISOString() });
    await this.out.manage(`${head}\n${word}: ${period} (${days} day${days > 1 ? 's' : ''})${note ? ` · ${note}` : ''}`, { absenceId: aid });
    await this.out.log(logLine(u, at, `${word.toLowerCase()} sent`, period));
    return okr(`${word} for ${period} was sent to management for approval. You will get a DM with the decision.`);
  }

  /** Approve or reject a requested absence. Returns the line to append to the card. */
  async decideAbsence(absenceId, approve, deciderId) {
    const a = this.db.getAbsence(absenceId);
    if (!a) return fail('Request not found.');
    if (a.state !== 'requested') return fail(`This request was already ${a.state}.`);
    const at = this.now();
    const decider = this.db.getUser(deciderId)?.name || `<@${deciderId}>`;
    const state = approve ? 'approved' : 'rejected';
    this.db.decideAbsence(absenceId, { state, by: String(deciderId), at: at.toISOString() });
    const u = this.db.getUser(a.discord_id);
    const period = a.start_date === a.end_date ? fmtDate(a.start_date) : `${fmtDate(a.start_date)} – ${fmtDate(a.end_date)}`;
    const word = a.kind === 'sick' ? 'sick report' : 'leave request';
    await this.out.dm(a.discord_id, `Your ${word} for ${period} was ${state} by ${decider}.`);
    await this.out.log(logLine(u, at, `${word} ${state}`, `by ${decider} · ${period}`));
    const today = wita(at).date;
    if (approve && a.start_date <= today && a.end_date >= today) await this._startAbsence(u, this.db.getAbsence(absenceId), at);
    return okr(`→ ${approve ? 'Approved' : 'Rejected'} by ${decider} at ${hm(at)} WITA`);
  }

  async _startAbsence(u, a, at) {
    const cur = this.db.getStatus(u.discord_id).status;
    const open = this.db.getOpenSession(u.discord_id);
    const d = decide(cur, { type: 'absence_start', kind: a.kind }, { hasOpenSession: !!open });
    if (cur === d.next && !d.closeSession) return;
    this.db.transaction(() => {
      if (d.closeSession) this.db.closeSession(open.id, { at: at.toISOString(), source: 'absence', flag: d.flag });
      this._setStatus(u, d.next, { at, source: a.kind, ref: `absence:${a.id}`, detail: a.end_date });
    });
    const backOn = (a.start_date === a.end_date && a.kind === 'sick') ? null : this.nextWorkingDate(u, a.end_date, false);
    await this.out.status(post(u, at, d.next, { backOn }));
    await this.out.log(logLine(u, at, `${LABEL[d.next]} started`, d.flag ? `flag: ${d.flag}` : `until ${fmtDate(a.end_date)}`));
  }

  /** 00:05 job: start absences that cover today, end ones that are over. */
  async applyAbsences() {
    const at = this.now();
    const today = wita(at).date;
    for (const a of this.db.absencesCovering(today)) {
      const u = this.user(a.discord_id);
      if (u) await this._startAbsence(u, a, at);
    }
    for (const st of this.db.listStatuses()) {
      if (!ABSENT.has(st.status)) continue;
      if (this.db.activeAbsence(st.discord_id, today)) continue;
      const u = this.user(st.discord_id);
      if (!u) continue;
      this._setStatus(u, S.OFFLINE, { at, source: 'absence end' });
      await this.out.log(logLine(u, at, `${LABEL[st.status]} ended`));
    }
  }

  // ---------- timed jobs ----------
  async expireMeetings() {
    const at = this.now();
    for (const st of this.db.listStatuses()) {
      if (st.status !== S.ON_MEETING || !st.expires_at || new Date(st.expires_at) > at) continue;
      const u = this.user(st.discord_id);
      if (!u) continue;
      this._setStatus(u, S.ONLINE, { at, source: 'meeting expired' });
      await this.out.status(post(u, at, S.ONLINE, { reason: 'meeting ended' }));
      await this.out.dm(u.discord_id, 'Your On-Meeting time is over, so your status is Online again. Use /status set on-meeting if the meeting continues.');
    }
  }

  /**
   * 22:00 job: close sessions that are still open.
   * @param {(user, session) => Promise<Date|null>} lastActivity optional: latest known activity (e.g. Clockify)
   */
  async autoClose(lastActivity = async () => null) {
    const at = this.now();
    for (const s of this.db.listOpenSessions()) {
      const u = this.db.getUser(s.discord_id);
      if (!u) continue;
      const st = this.db.getStatus(u.discord_id);
      let closeAt = null;
      try { closeAt = await lastActivity(u, s); } catch { closeAt = null; }
      const statusAt = st.since ? new Date(st.since) : null;
      if (statusAt && (!closeAt || statusAt > closeAt)) closeAt = statusAt;
      if (!closeAt || closeAt <= new Date(s.clock_in)) closeAt = witaToUtc(s.work_date, u.work_end);
      if (closeAt <= new Date(s.clock_in) || closeAt > at) closeAt = at;

      const d = decide(st.status, { type: 'auto_close' }, { hasOpenSession: true });
      this.db.transaction(() => {
        this.db.closeSession(s.id, { at: closeAt.toISOString(), source: 'auto', flag: d.flag });
        if (d.next !== st.status) this._setStatus(u, d.next, { at, source: 'auto close' });
      });
      const workedMs = closeAt - new Date(s.clock_in);
      await this.out.status(post(u, at, S.OFFLINE, { auto: true }));
      await this.out.log(logLine(u, at, 'auto clock-out', `closed at ${hm(closeAt)} · ${duration(workedMs)} · flag: forgot clock out`));
      await this.out.dm(u.discord_id, `You were clocked out automatically at ${hm(closeAt)} WITA because the session was still open at 22:00. If the time is wrong, please tell management.`);
    }
  }

  /** Users who should have clocked in by now on `date`. */
  missingClockIns(date) {
    return this.db.listUsers().filter((u) => u.clocks_in
      && this.isWorkingDay(u, date)
      && !this.db.activeAbsence(u.discord_id, date)
      && !this.db.latestSessionForDate(u.discord_id, date));
  }

  // ---------- board & reports ----------
  boardText() {
    const at = this.now();
    const groups = [S.ONLINE, S.ON_MEETING, S.PARTIAL, S.SICK, S.ON_LEAVE, S.OFFLINE];
    const byStatus = Object.fromEntries(groups.map((g) => [g, []]));
    for (const u of this.db.listUsers()) {
      const st = this.db.getStatus(u.discord_id);
      let extra = '';
      if (WORKING.has(st.status) && st.since) extra = ` · since ${hm(st.since)}`;
      if (st.status === S.ON_MEETING && st.expires_at) extra = ` · until ~${hm(st.expires_at)}`;
      byStatus[st.status].push(`${u.name} (${u.team})${extra}`);
    }
    const lines = [`**Team status** — updated ${stamp(at)}`];
    for (const g of groups) {
      if (!byStatus[g].length) continue;
      lines.push(`\n**${LABEL[g]} (${byStatus[g].length})**`);
      for (const l of byStatus[g]) lines.push(`• ${l}`);
    }
    lines.push('\nCommands: /clock-in · /clock-out · /status set · /status check · /sick · /on-leave · /myhours');
    return lines.join('\n');
  }

  dailyRecap(date = wita(this.now()).date) {
    const sessions = this.db.sessionsForDate(date);
    const users = this.db.listUsers();
    const sick = users.filter((u) => this.db.activeAbsence(u.discord_id, date)?.kind === 'sick');
    const leave = users.filter((u) => this.db.activeAbsence(u.discord_id, date)?.kind === 'leave');
    const missing = this.missingClockIns(date);
    const online = new Set(sessions.map((s) => s.discord_id));
    const lines = [
      `**Daily recap — ${fmtDate(date)}**`,
      `Clocked in: ${online.size} · Sick: ${sick.length} · On-Leave: ${leave.length} · Not clocked in: ${missing.length}`,
    ];
    for (const s of sessions) {
      const u = this.db.getUser(s.discord_id);
      const end = s.clock_out ? hm(s.clock_out) : 'open';
      const dur = s.clock_out ? duration(new Date(s.clock_out) - new Date(s.clock_in)) : '—';
      lines.push(`${u.name} — ${u.team} — ${hm(s.clock_in)}–${end} — ${dur}${s.flags ? ` — flag: ${s.flags}` : ''}`);
    }
    if (sick.length) lines.push(`Sick: ${sick.map((u) => u.name).join(', ')}`);
    if (leave.length) lines.push(`On-Leave: ${leave.map((u) => u.name).join(', ')}`);
    if (missing.length) lines.push(`Not clocked in: ${missing.map((u) => u.name).join(', ')}`);
    return lines.join('\n');
  }

  /** @param {Map<string, number|null>} clockifyMs per discord_id; null = not available */
  weeklyRecap(fromDate, toDate, clockifyMs = new Map()) {
    const lines = [`**Weekly recap — ${fmtDate(fromDate)} – ${fmtDate(toDate)}**`];
    for (const u of this.db.listUsers().filter((x) => x.clocks_in)) {
      const sessions = this.db.sessionsBetween(fromDate, toDate, u.discord_id);
      const presenceMs = sessions.filter((s) => s.clock_out).reduce((a, s) => a + (new Date(s.clock_out) - new Date(s.clock_in)), 0);
      let late = 0;
      let forgot = 0;
      for (const s of sessions) {
        const lateAt = witaToUtc(s.work_date, u.work_start).getTime() + this.config.lateGraceMin * 60000;
        if (new Date(s.clock_in).getTime() > lateAt && s.source_in !== 'claim') late += 1;
        if ((s.flags || '').includes('forgot clock out')) forgot += 1;
      }
      let missed = 0;
      let absent = 0;
      for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
        if (!this.isWorkingDay(u, d)) continue;
        if (this.db.activeAbsence(u.discord_id, d)) { absent += 1; continue; }
        if (!sessions.some((s) => s.work_date === d)) missed += 1;
      }
      const cMs = clockifyMs.has(u.discord_id) ? clockifyMs.get(u.discord_id) : undefined;
      const clockify = cMs === undefined ? 'n/a' : cMs === null ? 'pending' : duration(cMs);
      const ratio = typeof cMs === 'number' && presenceMs > 0 ? ` · ${Math.round((cMs / presenceMs) * 100)}%` : '';
      lines.push(`${u.name} — ${u.team} — presence ${duration(presenceMs)} · Clockify ${clockify}${ratio} · late ${late} · missed ${missed} · forgot ${forgot} · absent ${absent}`);
    }
    return lines.join('\n');
  }

  myHours(id, fromDate, toDate, clockifyMs) {
    const u = this.user(id);
    if (!u) return fail('You are not on the presence roster yet.');
    const sessions = this.db.sessionsBetween(fromDate, toDate, id);
    const openS = this.db.getOpenSession(id);
    let presenceMs = sessions.filter((s) => s.clock_out).reduce((a, s) => a + (new Date(s.clock_out) - new Date(s.clock_in)), 0);
    if (openS && openS.work_date >= fromDate && openS.work_date <= toDate) presenceMs += this.now() - new Date(openS.clock_in);
    const clockify = clockifyMs === undefined ? 'not linked' : clockifyMs === null ? 'pending (Clockify not reachable)' : duration(clockifyMs);
    const ratio = typeof clockifyMs === 'number' && presenceMs > 0 ? ` · Ratio: ${Math.round((clockifyMs / presenceMs) * 100)}%` : '';
    return okr(`${u.name} — ${fmtDate(fromDate)} – ${fmtDate(toDate)}\nPresence: ${duration(presenceMs)} · Clockify (tasks): ${clockify}${ratio}`);
  }

  attendanceText(date = wita(this.now()).date) {
    const lines = [`**Attendance — ${fmtDate(date)}** (now ${hm(this.now())} WITA)`];
    for (const u of this.db.listUsers()) {
      const st = this.db.getStatus(u.discord_id);
      const s = this.db.latestSessionForDate(u.discord_id, date);
      let when = '';
      if (s) when = ` · in ${hm(s.clock_in)}${s.clock_out ? ` · out ${hm(s.clock_out)}` : ''}`;
      else if (u.clocks_in && this.isWorkingDay(u, date) && !ABSENT.has(st.status)) when = ' · not clocked in';
      lines.push(`${u.name} — ${u.team} — ${LABEL[st.status]}${when}`);
    }
    return lines.join('\n');
  }

  // ---------- admin ----------
  async adminFixSession(targetId, { date, clockIn = null, clockOut = null }, adminId) {
    const u = this.user(targetId);
    if (!u) return fail('Not on the roster.');
    const s = this.db.latestSessionForDate(targetId, date);
    if (!s) return fail(`No session found for ${u.name} on ${fmtDate(date)}.`);
    const inIso = clockIn ? witaToUtc(date, clockIn).toISOString() : s.clock_in;
    const outIso = clockOut ? witaToUtc(date, clockOut).toISOString() : s.clock_out;
    if (outIso && outIso <= inIso) return fail('Clock-out must be after clock-in.');
    this.db.updateSessionTimes(s.id, { clockIn: inIso, clockOut: outIso, flag: 'corrected' });
    if (!s.clock_out && outIso) {
      const st = this.db.getStatus(targetId);
      if (WORKING.has(st.status)) this._setStatus(u, S.OFFLINE, { at: this.now(), source: 'manual' });
    }
    const admin = this.db.getUser(adminId)?.name || `<@${adminId}>`;
    await this.out.log(logLine(u, this.now(), 'session corrected', `${fmtDate(date)} ${hm(inIso)}–${outIso ? hm(outIso) : 'open'} by ${admin}`));
    return okr(`Session for ${u.name} on ${fmtDate(date)} is now ${hm(inIso)}–${outIso ? hm(outIso) : 'open'}.`);
  }

  async adminSetStatus(targetId, value, adminId) {
    const u = this.user(targetId);
    if (!u) return fail('Not on the roster.');
    const at = this.now();
    const admin = this.db.getUser(adminId)?.name || `<@${adminId}>`;
    const open = this.db.getOpenSession(targetId);
    if (value === S.OFFLINE && open) this.db.closeSession(open.id, { at: at.toISOString(), source: 'manual', flag: 'closed by management' });
    const prev = this._setStatus(u, value, { at, source: 'manual' });
    await this.out.status(post(u, at, value));
    await this.out.log(logLine(u, at, `status corrected ${LABEL[prev]} → ${LABEL[value]}`, `by ${admin}`));
    return okr(`${u.name} is now ${LABEL[value]}.`);
  }
}

export { statusLine };
