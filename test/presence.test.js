import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Presence } from '../src/service.js';
import { S, decide } from '../src/rules.js';
import { witaToUtc, duration, stamp, addMinutesHm } from '../src/time.js';
import { sumEntries } from '../src/clockify.js';
import { createScheduler } from '../src/scheduler.js';

const config = {
  policy: { sick: 'B', leave: 'A' }, autoClockInOnClaim: true, meetingDefaultMin: 30,
  lateGraceMin: 15, roles: { management: '999' }, backupDir: '/tmp/presence-test-backups',
};

function setup(startWita = '2026-11-23 09:02') {
  const db = openDb(':memory:');
  const sent = { status: [], manage: [], log: [], dm: [] };
  const out = {
    status: async (t) => { sent.status.push(t); },
    manage: async (t, o = {}) => { sent.manage.push({ t, ...o }); },
    log: async (t) => { sent.log.push(t); },
    dm: async (id, t) => { sent.dm.push({ id, t }); },
  };
  let now = witaToUtc(...startWita.split(' '));
  const clock = { set: (s) => { now = witaToUtc(...s.split(' ')); } };
  const p = new Presence({ db, out, config, now: () => now });
  db.upsertUser({ discord_id: '111111111111111111', name: 'Erico', team: 'Tech Team', kind: 'intern', clockify_user_id: 'c-erico' });
  db.upsertUser({ discord_id: '222222222222222222', name: 'Wira', team: 'Marketing', kind: 'core' });
  db.upsertUser({ discord_id: '333333333333333333', name: 'Azra', team: 'Intern', kind: 'intern' });
  return { db, p, sent, clock };
}
const ERICO = '111111111111111111';
const WIRA = '222222222222222222';
const AZRA = '333333333333333333';

test('time helpers', () => {
  assert.equal(stamp(witaToUtc('2026-11-23', '09:02')), '23 Nov 2026, 09:02 WITA');
  assert.equal(duration(8 * 3600000 + 8 * 60000), '8h 08m');
  assert.equal(addMinutesHm('09:00', -15), '08:45');
  assert.equal(addMinutesHm('00:05', -15), '23:50');
});

test('rules: claim never overrides sick; clock-in blocked when absent', () => {
  assert.equal(decide(S.SICK, { type: 'claim' }, { hasOpenSession: false }).next, S.SICK);
  assert.equal(decide(S.SICK, { type: 'clock_in' }).ok, false);
  assert.equal(decide(S.ON_MEETING, { type: 'claim' }, { hasOpenSession: true }).next, S.ONLINE);
  assert.equal(decide(S.OFFLINE, { type: 'set', value: S.PARTIAL }, { hasOpenSession: false }).ok, false);
  assert.equal(decide(S.ONLINE, { type: 'set', value: S.SICK }, { hasOpenSession: true }).ok, false);
});

test('clock in → posts the simple format; second clock in is blocked', async () => {
  const { p, sent } = setup();
  const r = await p.clockIn(ERICO);
  assert.ok(r.ok);
  assert.equal(sent.status[0], '[23 Nov 2026, 09:02 WITA] — Erico — Tech Team\nStatus: Online');
  const again = await p.clockIn(ERICO);
  assert.equal(again.ok, false);
  assert.match(again.message, /already online since 09:02/);
});

test('on-meeting, partial, clock out with hours', async () => {
  const { p, sent, clock } = setup();
  await p.clockIn(ERICO);
  clock.set('2026-11-23 10:30');
  await p.setStatus(ERICO, S.ON_MEETING);
  assert.equal(sent.status.at(-1), '[23 Nov 2026, 10:30 WITA] — Erico — Tech Team\nStatus: On-Meeting (Do Not Disturb) — please wait around 30 minutes');
  clock.set('2026-11-23 11:01');
  await p.expireMeetings();
  assert.equal(sent.status.at(-1), '[23 Nov 2026, 11:01 WITA] — Erico — Tech Team\nStatus: Online (meeting ended)');
  clock.set('2026-11-23 13:15');
  await p.setStatus(ERICO, S.PARTIAL);
  assert.equal(sent.status.at(-1), '[23 Nov 2026, 13:15 WITA] — Erico — Tech Team\nStatus: Partial (Slow Response) — replies may take longer');
  clock.set('2026-11-23 17:10');
  await p.clockOut(ERICO);
  assert.equal(sent.status.at(-1), '[23 Nov 2026, 17:10 WITA] — Erico — Tech Team\nStatus: Offline — clocked out · worked 8h 08m');
});

test('claim: partial → online with task; offline → auto clock-in; sick → flagged only', async () => {
  const { p, sent, clock, db } = setup();
  await p.clockIn(ERICO);
  await p.setStatus(ERICO, S.PARTIAL);
  clock.set('2026-11-23 14:02');
  await p.onClaim(ERICO, { task: 'Fix checkout webhook' });
  assert.equal(sent.status.at(-1), '[23 Nov 2026, 14:02 WITA] — Erico — Tech Team\nStatus: Online (working on: Fix checkout webhook)');

  await p.onClaim(AZRA, { task: 'Newsletter draft' });
  assert.ok(db.getOpenSession(AZRA));
  assert.match(db.getOpenSession(AZRA).flags, /auto clock-in via claim/);

  await p.reportAbsence(WIRA, 'sick');
  await p.onClaim(WIRA, { task: 'Ads report' });
  assert.equal(db.getStatus(WIRA).status, S.SICK);
  assert.match(sent.manage.at(-1).t, /task claimed while Sick/);
});

test('sick (policy B) posts immediately; leave (policy A) needs approval and starts on the day', async () => {
  const { p, sent, clock, db } = setup('2026-11-24 07:40');
  await p.reportAbsence(WIRA, 'sick');
  assert.equal(sent.status.at(-1), '[24 Nov 2026, 07:40 WITA] — Wira — Marketing\nStatus: Sick — not working today');
  assert.match(sent.manage.at(-1).t, /Sick report: 24 Nov 2026 \(1 day\) · Policy B: status set immediately/);

  clock.set('2026-11-24 10:12');
  const r = await p.reportAbsence(AZRA, 'leave', { from: '2026-11-25', to: '2026-11-26' });
  assert.ok(r.ok);
  const card = sent.manage.at(-1);
  assert.ok(card.absenceId);
  const d = await p.decideAbsence(card.absenceId, true, '999999999999999999');
  assert.match(d.message, /Approved by/);
  assert.equal(db.getStatus(AZRA).status, S.OFFLINE); // not yet, starts tomorrow

  clock.set('2026-11-25 00:05');
  await p.applyAbsences();
  assert.equal(sent.status.at(-1), '[25 Nov 2026, 00:05 WITA] — Azra — Intern\nStatus: On-Leave — back on 27 Nov 2026');

  clock.set('2026-11-27 00:05');
  await p.applyAbsences();
  assert.equal(db.getStatus(AZRA).status, S.OFFLINE);
});

test('auto clock-out at 22:00 uses scheduled end when no activity is known', async () => {
  const { p, sent, clock, db } = setup('2026-11-25 09:10');
  await p.clockIn(AZRA);
  clock.set('2026-11-25 22:00');
  await p.autoClose();
  assert.equal(sent.status.at(-1), '[25 Nov 2026, 22:00 WITA] — Azra — Intern\nStatus: Offline — auto clock-out (forgot to clock out, flagged for review)');
  const s = db.latestSessionForDate(AZRA, '2026-11-25');
  assert.match(s.flags, /forgot clock out/);
  assert.equal(new Date(s.clock_out).toISOString(), witaToUtc('2026-11-25', '17:00').toISOString());
});

test('mention auto-reply texts and status check privacy', async () => {
  const { p, clock } = setup('2026-11-23 18:00');
  assert.match(p.mentionReply(ERICO), /Erico is currently offline \(outside working hours\)\.\nYour message is noted — Erico will see it on Tue 24 Nov from 09:00 WITA\./);
  clock.set('2026-11-23 09:00');
  await p.clockIn(ERICO);
  assert.equal(p.mentionReply(ERICO), null); // online: no auto-reply
  await p.setStatus(ERICO, S.ON_MEETING, { minutes: 30 });
  assert.match(p.mentionReply(ERICO), /in a meeting until about 09:30 WITA/);

  await p.reportAbsence(WIRA, 'sick');
  assert.match(p.checkStatus(WIRA, { viewerIsManagement: false }).message, /Not available \(absent\)/);
  assert.match(p.checkStatus(WIRA, { viewerIsManagement: true }).message, /Status: Sick/);
  assert.match(p.mentionReply(WIRA), /Wira is not available today \(sick\)/);
});

test('clock out without clock in is allowed and flagged', async () => {
  const { p, sent } = setup();
  const r = await p.clockOut(WIRA);
  assert.ok(r.ok);
  assert.match(sent.log.at(-1), /no clock-in record/);
});

test('recaps and board render', async () => {
  const { p, clock } = setup('2026-11-23 09:30');
  await p.clockIn(ERICO);
  clock.set('2026-11-23 17:00');
  await p.clockOut(ERICO);
  const daily = p.dailyRecap('2026-11-23');
  assert.match(daily, /Erico — Tech Team — 09:30–17:00 — 7h 30m/);
  assert.match(daily, /Not clocked in: Wira, Azra|Not clocked in: Azra, Wira/);
  const weekly = p.weeklyRecap('2026-11-23', '2026-11-29', new Map([[ERICO, 6 * 3600000]]));
  assert.match(weekly, /Erico — Tech Team — presence 7h 30m · Clockify 6h 00m · 80% · late 1/);
  assert.match(p.boardText(), /\*\*Offline \(3\)\*\*/);
});

test('scheduler: 08:45 reminder DM, 09:15 missing list, weekend quiet', async () => {
  const { p, db, sent } = setup();
  let now = witaToUtc('2026-11-23', '08:45');
  const sched = createScheduler({ presence: p, db, clockify: { enabled: false }, out: {
    dm: async (id, t) => sent.dm.push({ id, t }), log: async (t) => sent.log.push(t), status: async () => {}, manage: async () => {},
  }, config: { ...config, claimPollSec: 60 }, now: () => now });
  await sched.tick();
  assert.equal(sent.dm.length, 3);
  assert.match(sent.dm[0].t, /Your day starts at 09:00/);
  now = witaToUtc('2026-11-23', '09:15');
  await sched.tick();
  assert.match(sent.log.at(-1), /Not clocked in yet \(09:15 WITA\)/);
  const before = sent.dm.length;
  now = witaToUtc('2026-11-28', '08:45'); // Saturday
  await sched.tick();
  assert.equal(sent.dm.length, before);
});

test('clockify sum clips to range and counts running timers', () => {
  const start = '2026-11-23T00:00:00Z';
  const end = '2026-11-24T00:00:00Z';
  const total = sumEntries([
    { timeInterval: { start: '2026-11-23T01:00:00Z', end: '2026-11-23T03:00:00Z' } },
    { timeInterval: { start: '2026-11-23T05:00:00Z', end: null } },
  ], start, end, '2026-11-23T06:30:00Z');
  assert.equal(total, 3.5 * 3600000);
});
