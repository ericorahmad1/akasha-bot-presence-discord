// Status state machine. Pure functions only: no database, no Discord.
export const S = Object.freeze({
  ONLINE: 'ONLINE',
  PARTIAL: 'PARTIAL',
  ON_MEETING: 'ON_MEETING',
  SICK: 'SICK',
  ON_LEAVE: 'ON_LEAVE',
  OFFLINE: 'OFFLINE',
});

export const WORKING = new Set([S.ONLINE, S.PARTIAL, S.ON_MEETING]);
export const ABSENT = new Set([S.SICK, S.ON_LEAVE]);
/** Statuses that get a polite auto-reply when mentioned. */
export const NOT_AVAILABLE = new Set([S.OFFLINE, S.SICK, S.ON_LEAVE, S.ON_MEETING]);

const ok = (next, extra = {}) => ({ ok: true, next, ...extra });
const no = (reason) => ({ ok: false, reason });

/**
 * Decide what an event does to a person's current status.
 * @param {string} current  current status
 * @param {{type:string, value?:string, kind?:string}} event
 * @param {{autoClockInOnClaim?:boolean, hasOpenSession?:boolean}} opts
 * @returns {{ok:boolean, next?:string, reason?:string, openSession?:boolean, closeSession?:boolean, flag?:string, notifyManagement?:boolean, noop?:boolean}}
 */
export function decide(current, event, opts = {}) {
  switch (event.type) {
    case 'clock_in':
      if (ABSENT.has(current)) return no(`You are marked ${current === S.SICK ? 'sick' : 'on leave'} today. Ask management to correct it if you are working.`);
      if (opts.hasOpenSession || WORKING.has(current)) return no('You are already clocked in.');
      return ok(S.ONLINE, { openSession: true });

    case 'clock_out':
      if (!opts.hasOpenSession) return ok(ABSENT.has(current) ? current : S.OFFLINE, { flag: 'no clock-in record' });
      return ok(ABSENT.has(current) ? current : S.OFFLINE, { closeSession: true });

    case 'set': {
      const target = event.value;
      if (!WORKING.has(target)) return no('Use /sick or /on-leave for absences.');
      if (!opts.hasOpenSession) return no('Please /clock-in first.');
      if (target === current && target !== S.ON_MEETING) return ok(current, { noop: true });
      return ok(target);
    }

    case 'claim':
      if (ABSENT.has(current)) return ok(current, { flag: 'claim during absence', notifyManagement: true });
      if (!opts.hasOpenSession) {
        if (opts.autoClockInOnClaim) return ok(S.ONLINE, { openSession: true, flag: 'auto clock-in via claim' });
        return ok(current, { flag: 'claim while offline' });
      }
      if (current === S.ONLINE) return ok(S.ONLINE, { noop: true });
      return ok(S.ONLINE);

    case 'meeting_expired':
      return current === S.ON_MEETING ? ok(S.ONLINE) : ok(current, { noop: true });

    case 'absence_start': {
      const next = event.kind === 'sick' ? S.SICK : S.ON_LEAVE;
      if (opts.hasOpenSession) return ok(next, { closeSession: true, flag: 'left early' });
      return ok(next);
    }

    case 'absence_end':
      return ABSENT.has(current) ? ok(S.OFFLINE) : ok(current, { noop: true });

    case 'auto_close':
      if (!opts.hasOpenSession) return ok(current, { noop: true });
      return ok(ABSENT.has(current) ? current : S.OFFLINE, { closeSession: true, flag: 'forgot clock out' });

    default:
      return no(`Unknown event ${event.type}`);
  }
}
