// All times are stored in UTC (ISO strings) and shown in WITA (Asia/Makassar, UTC+8, no daylight saving).
const OFFSET_MS = 8 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pad = (n) => String(n).padStart(2, '0');

/** Parts of a moment in WITA. weekday: 1 = Monday ... 7 = Sunday. */
export function wita(date = new Date()) {
  const d = new Date(new Date(date).getTime() + OFFSET_MS);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  return {
    year, month, day, hour, minute,
    weekday: ((d.getUTCDay() + 6) % 7) + 1,
    date: `${year}-${pad(month)}-${pad(day)}`,
    hm: `${pad(hour)}:${pad(minute)}`,
  };
}

/** "23 Nov 2026, 09:02 WITA" */
export function stamp(date) {
  const w = wita(date);
  return `${w.day} ${MONTHS[w.month - 1]} ${w.year}, ${w.hm} WITA`;
}

/** "09:02" in WITA */
export function hm(date) {
  return wita(date).hm;
}

/** "2026-11-27" -> "27 Nov 2026" */
export function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "2026-11-25" -> "Wed 25 Nov" */
export function fmtDay(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${DAYS[weekdayOf(dateStr) - 1]} ${d} ${MONTHS[m - 1]}`;
}

/** WITA date + "HH:MM" -> Date (UTC instant) */
export function witaToUtc(dateStr, hhmm = '00:00') {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, mi) - OFFSET_MS);
}

export function addDays(dateStr, n) {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function weekdayOf(dateStr) {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  return ((dt.getUTCDay() + 6) % 7) + 1;
}

export function addMinutesHm(hhmm, delta) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = (((h * 60 + m + delta) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

/** 29280000 -> "8h 08m" */
export function duration(ms) {
  const total = Math.max(0, Math.round(ms / 60000));
  return `${Math.floor(total / 60)}h ${pad(total % 60)}m`;
}

export function isDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isHm(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
}

export function daysBetween(fromStr, toStr) {
  return Math.round((new Date(`${toStr}T00:00:00Z`) - new Date(`${fromStr}T00:00:00Z`)) / 86400000);
}
