// SQLite storage using Node's built-in node:sqlite (Node >= 22.13). Own file, separate from meeting-bot.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { S } from './rules.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  team TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'core' CHECK (kind IN ('intern','core','management')),
  clocks_in INTEGER NOT NULL DEFAULT 1,
  clockify_user_id TEXT,
  work_start TEXT NOT NULL DEFAULT '09:00',
  work_end TEXT NOT NULL DEFAULT '17:00',
  work_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS users_clockify ON users(clockify_user_id) WHERE clockify_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  discord_id TEXT NOT NULL REFERENCES users(discord_id),
  work_date TEXT NOT NULL,
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  source_in TEXT NOT NULL,
  source_out TEXT,
  flags TEXT NOT NULL DEFAULT '',
  note TEXT CHECK (note IS NULL OR length(note) <= 80)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_session ON sessions(discord_id) WHERE clock_out IS NULL;
CREATE INDEX IF NOT EXISTS sessions_date ON sessions(work_date);

CREATE TABLE IF NOT EXISTS user_status (
  discord_id TEXT PRIMARY KEY REFERENCES users(discord_id),
  status TEXT NOT NULL,
  since TEXT NOT NULL,
  expires_at TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS status_events (
  id INTEGER PRIMARY KEY,
  discord_id TEXT NOT NULL,
  status TEXT NOT NULL,
  prev_status TEXT,
  source TEXT NOT NULL,
  at TEXT NOT NULL,
  ref TEXT
);
CREATE INDEX IF NOT EXISTS events_at ON status_events(at);

CREATE TABLE IF NOT EXISTS absences (
  id INTEGER PRIMARY KEY,
  discord_id TEXT NOT NULL REFERENCES users(discord_id),
  kind TEXT NOT NULL CHECK (kind IN ('sick','leave')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  note TEXT CHECK (note IS NULL OR length(note) <= 80),
  state TEXT NOT NULL CHECK (state IN ('requested','approved','rejected','declared','cancelled')),
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS holidays (date TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return createRepo(db);
}

function createRepo(db) {
  const q = (sql) => db.prepare(sql);
  const plain = (row) => (row ? { ...row } : undefined);

  return {
    raw: db,

    transaction(fn) {
      db.exec('BEGIN');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    // ---- users ----
    upsertUser(u) {
      q(`INSERT INTO users (discord_id, name, team, kind, clocks_in, clockify_user_id, work_start, work_end, work_days, active)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(discord_id) DO UPDATE SET name=excluded.name, team=excluded.team, kind=excluded.kind,
           clocks_in=excluded.clocks_in, clockify_user_id=excluded.clockify_user_id, work_start=excluded.work_start,
           work_end=excluded.work_end, work_days=excluded.work_days, active=excluded.active`).run(
        String(u.discord_id), u.name, u.team || '', u.kind || 'core', u.clocks_in === false ? 0 : 1,
        u.clockify_user_id || null, u.work_start || '09:00', u.work_end || '17:00',
        u.work_days || '1,2,3,4,5', u.active === false ? 0 : 1,
      );
    },
    getUser: (id) => plain(q('SELECT * FROM users WHERE discord_id = ?').get(String(id))),
    getUserByClockify: (cid) => plain(q('SELECT * FROM users WHERE clockify_user_id = ? AND active = 1').get(cid)),
    listUsers: () => q('SELECT * FROM users WHERE active = 1 ORDER BY team, name').all().map(plain),

    // ---- status ----
    getStatus(id) {
      return plain(q('SELECT * FROM user_status WHERE discord_id = ?').get(String(id)))
        || { discord_id: String(id), status: S.OFFLINE, since: null, expires_at: null, detail: null };
    },
    setStatus(id, status, { at, expiresAt = null, detail = null }) {
      q(`INSERT INTO user_status (discord_id, status, since, expires_at, detail) VALUES (?,?,?,?,?)
         ON CONFLICT(discord_id) DO UPDATE SET status=excluded.status, since=excluded.since,
           expires_at=excluded.expires_at, detail=excluded.detail`).run(String(id), status, at, expiresAt, detail);
    },
    listStatuses: () => q('SELECT * FROM user_status').all().map(plain),
    addEvent({ discordId, status, prev, source, at, ref = null }) {
      q('INSERT INTO status_events (discord_id, status, prev_status, source, at, ref) VALUES (?,?,?,?,?,?)')
        .run(String(discordId), status, prev, source, at, ref);
    },
    eventsBetween: (fromIso, toIso) => q('SELECT * FROM status_events WHERE at >= ? AND at < ? ORDER BY at').all(fromIso, toIso).map(plain),

    // ---- sessions ----
    openSession({ discordId, workDate, at, source, note = null, flags = '' }) {
      const r = q('INSERT INTO sessions (discord_id, work_date, clock_in, source_in, note, flags) VALUES (?,?,?,?,?,?)')
        .run(String(discordId), workDate, at, source, note, flags);
      return Number(r.lastInsertRowid);
    },
    getOpenSession: (id) => plain(q('SELECT * FROM sessions WHERE discord_id = ? AND clock_out IS NULL').get(String(id))),
    listOpenSessions: () => q('SELECT * FROM sessions WHERE clock_out IS NULL').all().map(plain),
    closeSession(sessionId, { at, source, flag = null }) {
      const s = plain(q('SELECT * FROM sessions WHERE id = ?').get(sessionId));
      const flags = flag ? addFlag(s.flags, flag) : s.flags;
      q('UPDATE sessions SET clock_out = ?, source_out = ?, flags = ? WHERE id = ?').run(at, source, flags, sessionId);
      return { ...s, clock_out: at, source_out: source, flags };
    },
    getSession: (sid) => plain(q('SELECT * FROM sessions WHERE id = ?').get(sid)),
    updateSessionTimes(sid, { clockIn, clockOut, flag }) {
      const s = plain(q('SELECT * FROM sessions WHERE id = ?').get(sid));
      q('UPDATE sessions SET clock_in = ?, clock_out = ?, source_out = ?, flags = ? WHERE id = ?')
        .run(clockIn ?? s.clock_in, clockOut ?? s.clock_out, 'manual', flag ? addFlag(s.flags, flag) : s.flags, sid);
    },
    sessionsForDate: (date) => q('SELECT * FROM sessions WHERE work_date = ? ORDER BY clock_in').all(date).map(plain),
    sessionsBetween: (fromDate, toDate, id = null) => (id
      ? q('SELECT * FROM sessions WHERE work_date BETWEEN ? AND ? AND discord_id = ? ORDER BY clock_in').all(fromDate, toDate, String(id))
      : q('SELECT * FROM sessions WHERE work_date BETWEEN ? AND ? ORDER BY clock_in').all(fromDate, toDate)).map(plain),
    latestSessionForDate: (id, date) => plain(q('SELECT * FROM sessions WHERE discord_id = ? AND work_date = ? ORDER BY clock_in DESC LIMIT 1').get(String(id), date)),

    // ---- absences ----
    createAbsence({ discordId, kind, start, end, note = null, state, at }) {
      const r = q('INSERT INTO absences (discord_id, kind, start_date, end_date, note, state, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(String(discordId), kind, start, end, note, state, at);
      return Number(r.lastInsertRowid);
    },
    getAbsence: (aid) => plain(q('SELECT * FROM absences WHERE id = ?').get(aid)),
    decideAbsence(aid, { state, by, at }) {
      q('UPDATE absences SET state = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(state, by, at, aid);
    },
    /** approved or declared absence covering a date */
    activeAbsence: (id, date) => plain(q(`SELECT * FROM absences WHERE discord_id = ? AND state IN ('approved','declared')
       AND start_date <= ? AND end_date >= ? ORDER BY id DESC LIMIT 1`).get(String(id), date, date)),
    absencesCovering: (date) => q(`SELECT * FROM absences WHERE state IN ('approved','declared')
       AND start_date <= ? AND end_date >= ?`).all(date, date).map(plain),
    absencesOverlapping: (fromDate, toDate) => q(`SELECT * FROM absences WHERE state IN ('approved','declared')
       AND start_date <= ? AND end_date >= ?`).all(toDate, fromDate).map(plain),

    // ---- holidays ----
    isHoliday: (date) => !!q('SELECT 1 FROM holidays WHERE date = ?').get(date),
    addHoliday: (date, name) => q('INSERT INTO holidays (date, name) VALUES (?,?) ON CONFLICT(date) DO UPDATE SET name = excluded.name').run(date, name),

    // ---- key/value + run-once markers ----
    kvGet: (key) => q('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null,
    kvSet: (key, value) => q('INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)),
    /** returns true the first time a key is marked */
    markOnce: (key) => Number(q('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)').run(key, new Date().toISOString()).changes) === 1,
    pruneKv: (prefix, beforeIso) => q('DELETE FROM kv WHERE key LIKE ? AND value < ?').run(`${prefix}%`, beforeIso),

    // ---- maintenance ----
    backupTo(file) {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      if (fs.existsSync(file)) fs.rmSync(file);
      db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    },
    deleteOlderThan(dateStr) {
      q('DELETE FROM sessions WHERE work_date < ? AND clock_out IS NOT NULL').run(dateStr);
      q('DELETE FROM status_events WHERE at < ?').run(`${dateStr}T00:00:00.000Z`);
      q("DELETE FROM absences WHERE end_date < ?").run(dateStr);
    },
  };
}

export function addFlag(flags, flag) {
  const list = (flags || '').split(',').map((f) => f.trim()).filter(Boolean);
  if (!list.includes(flag)) list.push(flag);
  return list.join(', ');
}
