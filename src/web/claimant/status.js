// Claim status: timeline view-model and a polling controller.
// Pure logic; inject { api, timers, isHidden }.

export const TERMINAL_STATUSES = ['closed', 'withdrawn'];
export const DEFAULT_INTERVAL_MS = 10000;
const MAX_BACKOFF_MS = 60000;

// Linear happy path. fast_tracked shares the assigned slot, pending_info shares in_review.
const STAGES = ['reported', 'validating', 'triaged', 'assigned', 'in_review', 'closed'];
const SLOT = { fast_tracked: 'assigned', pending_info: 'in_review' };

/** @param {string} status */
export function isTerminal(status) { return TERMINAL_STATUSES.includes(status); }

/** Timeline slot (stage id) of a claim status. */
export function stageOf(status) {
  return SLOT[status] ?? status;
}

/**
 * Remember when each stage was reached, so completed steps keep a date (the claimant projection has no status history).
 * Stages passed between two observations get the time of the observation that showed them complete (claim.updatedAt):
 * the claim had moved past them by then. Pure: returns a new map.
 * @param {Record<string, string>} times stage id -> ISO time
 * @param {{ status: string, reportedAt?: string, updatedAt?: string }} claim
 * @returns {Record<string, string>}
 */
export function mergeStageTimes(times, claim) {
  const out = { ...(times ?? {}) };
  if (!claim?.status) return out;
  if (claim.reportedAt && !out.reported) out.reported = claim.reportedAt;
  const stages = claim.status === 'withdrawn' ? ['reported', 'withdrawn'] : STAGES;
  const idx = stages.indexOf(stageOf(claim.status));
  const at = claim.updatedAt ?? claim.reportedAt;
  if (idx < 0 || !at) return out;
  for (let i = 1; i <= idx; i += 1) if (!out[stages[i]]) out[stages[i]] = at;
  return out;
}

/**
 * Build timeline items for fx-timeline.
 * @param {{ status: string, reportedAt?: string, updatedAt?: string }} claim
 * @param {Function} t
 * @param {Record<string, string>} [times] stage id -> when it was reached (mergeStageTimes); completed steps show it
 * @returns {{ id: string, label: string, state: 'done'|'current'|'upcoming', stateLabel: string, at?: string, attention?: boolean }[]}
 */
export function buildTimeline(claim, t, times = {}) {
  const status = claim?.status ?? 'reported';
  const stages = status === 'withdrawn' ? ['reported', 'withdrawn'] : [...STAGES];
  const slot = SLOT[status] ?? status;
  let idx = stages.indexOf(slot);
  if (idx < 0) idx = 0;
  const terminal = isTerminal(status);
  return stages.map((id, i) => {
    const state = i < idx || (terminal && i === idx) ? 'done' : i === idx ? 'current' : 'upcoming';
    const shownId = i === idx && SLOT[status] ? status : id;
    const item = {
      id: shownId,
      label: t(`claimant.status.${shownId}`),
      state,
      stateLabel: t(state === 'done' ? 'claimant.status.complete' : state === 'current' ? 'claimant.status.current' : 'claimant.status.upcoming')
    };
    if (state !== 'upcoming' && times?.[id]) item.at = times[id];
    if (i === 0 && claim?.reportedAt) item.at = claim.reportedAt;
    if (i === idx && claim?.updatedAt && !(times?.[id])) item.at = claim.updatedAt;
    if (status === 'pending_info' && i === idx) item.attention = true;
    return item;
  });
}

/**
 * Poll GET /claims/{id}. Stops on terminal status, pauses while hidden.
 * @param {{ api: any, claimId: string, timers?: { setTimeout: Function, clearTimeout: Function },
 *           intervalMs?: number, isHidden?: () => boolean, clock?: { now(): number } }} deps
 */
export function createStatusPoller({ api, claimId, timers = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) }, intervalMs = DEFAULT_INTERVAL_MS, isHidden = () => false, clock = { now: () => Date.now() } }) {
  const listeners = new Set();
  let handle = null;
  let running = false;
  let inFlight = false;
  let failures = 0;
  const state = { claim: null, status: null, final: false, paused: false, stale: false, error: null, checkedAt: null, running: false };

  const emit = () => { const s = { ...state, running }; for (const l of listeners) l(s); };
  const clear = () => { if (handle != null) { timers.clearTimeout(handle); handle = null; } };
  const schedule = () => {
    clear();
    if (!running || state.final || state.paused) return;
    const delay = Math.min(intervalMs * 2 ** Math.min(failures, 3), Math.max(intervalMs, MAX_BACKOFF_MS));
    handle = timers.setTimeout(tick, delay);
  };

  async function tick() {
    handle = null;
    if (!running || state.final) return;
    if (isHidden()) { state.paused = true; emit(); return; }
    await refresh();
    schedule();
  }

  async function refresh() {
    if (inFlight) return state.claim;
    inFlight = true;
    try {
      const claim = await api.get(`/claims/${claimId}`);
      failures = 0;
      state.claim = claim; state.status = claim.status; state.stale = false; state.error = null;
      state.checkedAt = clock.now();
      if (isTerminal(claim.status)) { state.final = true; running = false; clear(); }
    } catch (err) {
      failures += 1;
      state.stale = true;
      state.error = { code: err?.code ?? 'error', message: err?.message ?? String(err) };
    } finally {
      inFlight = false;
      emit();
    }
    return state.claim;
  }

  return {
    get state() { return { ...state, running }; },
    subscribe(fn) { listeners.add(fn); fn({ ...state, running }); return () => listeners.delete(fn); },
    /** Fetch now, then keep polling. */
    async start() {
      if (running) return;
      running = true; state.final = false; state.paused = false;
      await refresh();
      schedule();
    },
    stop() { running = false; clear(); emit(); },
    /** Manual refresh; does not change the schedule except to restart it. */
    async refresh() { const c = await refresh(); schedule(); return c; },
    /** Wire to document visibilitychange. */
    async setHidden(hidden) {
      if (!running || state.final) return;
      if (hidden) { state.paused = true; clear(); emit(); return; }
      if (state.paused) { state.paused = false; emit(); await refresh(); schedule(); }
    }
  };
}
