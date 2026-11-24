// Read-only Clockify client. Never starts, stops or edits timers.
const BASE = 'https://api.clockify.me/api/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClockify({ apiKey, workspaceId, fetchImpl = globalThis.fetch, baseUrl = BASE } = {}) {
  const enabled = Boolean(apiKey && workspaceId);

  async function get(pathname, params = {}) {
    const url = new URL(baseUrl + pathname);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetchImpl(url, { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' } });
        if (res.status === 429 || res.status >= 500) throw new Error(`Clockify ${res.status}`);
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const e = new Error(`Clockify ${res.status}: ${body.slice(0, 200)}`);
          e.permanent = true;
          throw e;
        }
        return await res.json();
      } catch (e) {
        lastErr = e;
        if (e.permanent) break;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  return {
    enabled,

    /** All running timers in the workspace (needs a workspace admin key). */
    async inProgress() {
      if (!enabled) return [];
      const out = [];
      for (let page = 1; page <= 5; page += 1) {
        const batch = await get(`/workspaces/${workspaceId}/time-entries/status/in-progress`, { page, 'page-size': 200 });
        out.push(...batch);
        if (batch.length < 200) break;
      }
      return out;
    },

    /** Time entries for one user between two instants. */
    async userEntries(userId, start, end) {
      if (!enabled) return [];
      const out = [];
      for (let page = 1; page <= 10; page += 1) {
        const batch = await get(`/workspaces/${workspaceId}/user/${userId}/time-entries`, {
          start: new Date(start).toISOString(), end: new Date(end).toISOString(), page, 'page-size': 500,
        });
        out.push(...batch);
        if (batch.length < 500) break;
      }
      return out;
    },

    /** Total tracked milliseconds, counting running timers up to `now`, clipped to [start, end]. */
    async userTotalMs(userId, start, end, now = new Date()) {
      const entries = await this.userEntries(userId, start, end);
      return sumEntries(entries, start, end, now);
    },

    /** Latest end time of today's entries (for auto clock-out). */
    async lastActivity(userId, start, end) {
      const entries = await this.userEntries(userId, start, end);
      let latest = null;
      for (const e of entries) {
        const t = e.timeInterval?.end ? new Date(e.timeInterval.end) : null;
        if (t && (!latest || t > latest)) latest = t;
      }
      return latest;
    },
  };
}

export function sumEntries(entries, start, end, now = new Date()) {
  const s0 = new Date(start).getTime();
  const e0 = new Date(end).getTime();
  let total = 0;
  for (const e of entries) {
    const a = Math.max(new Date(e.timeInterval.start).getTime(), s0);
    const b = Math.min(e.timeInterval.end ? new Date(e.timeInterval.end).getTime() : new Date(now).getTime(), e0);
    if (b > a) total += b - a;
  }
  return total;
}
