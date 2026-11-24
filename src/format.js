// All user-facing text in one place, so wording can be changed without touching logic.
import { S } from './rules.js';
import { stamp, hm, fmtDate, duration } from './time.js';

export const LABEL = {
  [S.ONLINE]: 'Online',
  [S.PARTIAL]: 'Partial (Slow Response)',
  [S.ON_MEETING]: 'On-Meeting (Do Not Disturb)',
  [S.SICK]: 'Sick',
  [S.ON_LEAVE]: 'On-Leave',
  [S.OFFLINE]: 'Offline',
};

/** The "Status: ..." line of a post. */
export function statusLine(status, ctx = {}) {
  switch (status) {
    case S.ONLINE:
      if (ctx.task) return `Online (working on: ${ctx.task})`;
      if (ctx.reason) return `Online (${ctx.reason})`;
      return 'Online';
    case S.PARTIAL:
      return 'Partial (Slow Response) — replies may take longer';
    case S.ON_MEETING:
      return `On-Meeting (Do Not Disturb) — please wait around ${ctx.minutes ?? 30} minutes`;
    case S.SICK:
      return ctx.backOn ? `Sick — back on ${fmtDate(ctx.backOn)}` : 'Sick — not working today';
    case S.ON_LEAVE:
      return ctx.backOn ? `On-Leave — back on ${fmtDate(ctx.backOn)}` : 'On-Leave';
    case S.OFFLINE:
      if (ctx.auto) return 'Offline — auto clock-out (forgot to clock out, flagged for review)';
      if (ctx.workedMs !== undefined) return `Offline — clocked out · worked ${duration(ctx.workedMs)}`;
      return 'Offline';
    default:
      return status;
  }
}

/** "[23 Nov 2026, 09:02 WITA] — Erico — Tech Team\nStatus: Online" */
export function post(user, at, status, ctx = {}) {
  return `[${stamp(at)}] — ${user.name} — ${user.team}\nStatus: ${statusLine(status, ctx)}`;
}

/** Audit line for #team-status-log */
export function logLine(user, at, what, extra = '') {
  return `[${stamp(at)}] — ${user.name} — ${user.team} · ${what}${extra ? ` · ${extra}` : ''}`;
}

export function managementRef(roleId) {
  return roleId ? `<@&${roleId}>` : 'management';
}

/** Ephemeral answer for /status check */
export function checkText(user, st, ctx) {
  const since = st.since ? ` (since ${stamp(st.since).replace(/ \d{4},/, ',')})` : '';
  const head = `${user.name} — ${user.team}`;
  switch (st.status) {
    case S.ONLINE:
      return `${head}\nStatus: Online${since}\nReachable now — normal response.`;
    case S.PARTIAL:
      return `${head}\nStatus: Partial (Slow Response)${since}\nOnline with limited capacity — replies may take longer.`;
    case S.ON_MEETING:
      return `${head}\nStatus: On-Meeting${since}\nIn a meeting until about ${hm(st.expires_at)} WITA. Expected reply in about 30 minutes.`;
    case S.SICK:
    case S.ON_LEAVE:
      if (!ctx.showAbsenceType) return `${head}\nStatus: Not available (absent)\nPlease follow up when ${user.name} is back${ctx.backOn ? ` (${fmtDate(ctx.backOn)})` : ''}.`;
      if (st.status === S.SICK) return `${head}\nStatus: Sick${since}\nNot available today. Please follow up when ${user.name} is back.`;
      return `${head}\nStatus: On-Leave${since}\nOn leave until ${fmtDate(st.detail)}. Please follow up after the leave.`;
    default:
      return `${head}\nStatus: Offline${since}\nOutside working hours. ${user.name} will see messages ${ctx.nextWindow}.`;
  }
}

/** Public auto-reply when someone mentions a person who is not available. */
export function mentionText(user, st, ctx) {
  const urgent = `If it is urgent, please contact ${ctx.management}.`;
  switch (st.status) {
    case S.ON_MEETING:
      return `${user.name} is in a meeting until about ${hm(st.expires_at)} WITA.\nPlease wait around 30 minutes for a reply.`;
    case S.SICK:
      return `${user.name} is not available today (sick).\nPlease follow up when ${user.name} is back, or contact ${ctx.management} if it is urgent.`;
    case S.ON_LEAVE:
      return `${user.name} is on leave until ${fmtDate(st.detail)}.\nPlease follow up after the leave, or contact ${ctx.management} if it is urgent.`;
    case S.OFFLINE:
      return `${user.name} is currently offline (outside working hours).\nYour message is noted — ${user.name} will see it ${ctx.nextWindow}.\n${urgent}`;
    default:
      return null;
  }
}
