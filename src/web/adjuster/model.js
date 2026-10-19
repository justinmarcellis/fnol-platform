// Pure view-model helpers for the adjuster inbox: rows, KPI counts, filters, timer urgency.
// No DOM and no kit imports, so it runs and tests in node.

export const CLOSED_STATUSES = ['closed', 'withdrawn'];
export const SEVERITY_BANDS = ['minor', 'moderate', 'major', 'severe'];
const HOUR = 3600000;

/** Severity band from a 0-100 score (0-24 minor, 25-49 moderate, 50-74 major, 75+ severe), or null. */
export function severityBand(score) {
  if (!Number.isFinite(score)) return null;
  return score >= 75 ? 'severe' : score >= 50 ? 'major' : score >= 25 ? 'moderate' : 'minor';
}

/**
 * Timer urgency at `now`. Pure.
 * tone: danger (overdue), warning (due within 4 h or flagged due soon), info (within 24 h), neutral (later), success (met).
 * @returns {{state:'none'|'met'|'overdue'|'due_soon'|'running', ms:number, tone:string}}
 */
export function timerUrgency(timer, now = Date.now()) {
  if (!timer || timer.status === 'cancelled') return { state: 'none', ms: 0, tone: 'neutral' };
  if (timer.status === 'met') return { state: 'met', ms: 0, tone: 'success' };
  const due = Date.parse(timer.dueAt);
  const ms = Number.isNaN(due) ? 0 : due - now;
  if (timer.status === 'breached' || (!Number.isNaN(due) && ms < 0)) return { state: 'overdue', ms, tone: 'danger' };
  const soon = timer.status === 'due_soon' || (timer.warnAt && Date.parse(timer.warnAt) <= now) || ms <= 4 * HOUR;
  if (soon) return { state: 'due_soon', ms, tone: 'warning' };
  return { state: 'running', ms, tone: ms <= 24 * HOUR ? 'info' : 'neutral' };
}

/** Most urgent open timer of a list (earliest due), or undefined. */
export function nextOpenTimer(timers = []) {
  return [...timers].filter((x) => !['met', 'cancelled'].includes(x.status)).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0];
}

/** Local calendar day key, so "due today" follows the adjuster's clock. */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Display name for a party object (person or organisation), or ''. */
export function partyName(p) {
  if (!p) return '';
  const person = [p.firstName, p.lastName].filter(Boolean).join(' ');
  return person || p.organizationName || '';
}

/** The insured party's name from a claim with parties, or ''. */
export function insuredName(claim) {
  const parties = claim?.parties ?? [];
  const p = parties.find((x) => (x.roles ?? []).includes('insured')) ?? parties.find((x) => x.isPolicyParty) ?? parties[0];
  return partyName(p);
}

/**
 * Row view-model for one inbox item. `insureds` maps claimId -> name once it has loaded.
 * assignedAt falls back to reportedAt until the inbox feed carries an assignment time.
 */
export function inboxRow(item, { insureds = {}, now = Date.now() } = {}) {
  const timer = item.nextTimer;
  const u = timerUrgency(timer, now);
  const assignedAt = item.assignedAt ?? item.reportedAt;
  const ts = Date.parse(assignedAt);
  return {
    claimId: item.claimId,
    claimNumber: item.claimNumber ?? item.claimId,
    insured: item.insuredName ?? insureds[item.claimId] ?? '',
    lob: item.lob ?? '',
    severityScore: Number.isFinite(item.severityScore) ? item.severityScore : null,
    severityBand: severityBand(item.severityScore),
    status: item.status ?? '',
    flags: item.flags ?? [],
    queue: item.queue ?? '',
    timer,
    timerState: u.state,
    timerTone: u.tone,
    timerMs: u.state === 'none' || u.state === 'met' ? Number.MAX_SAFE_INTEGER : u.ms,
    assignedAt,
    assignedTs: Number.isNaN(ts) ? 0 : ts,
    assignedApprox: !item.assignedAt,
  };
}

/** Build every row. */
export function inboxRows(items = [], opts = {}) {
  return items.map((i) => inboxRow(i, opts));
}

/**
 * KPI tiles over a set of rows: open, due today (open timer due later today), overdue, fast-tracked.
 * @returns {{open:number, dueToday:number, overdue:number, fastTracked:number}}
 */
export function inboxKpis(rows = [], now = Date.now()) {
  const today = dayKey(now);
  let open = 0; let dueToday = 0; let overdue = 0; let fastTracked = 0;
  for (const r of rows) {
    if (!CLOSED_STATUSES.includes(r.status)) open++;
    if (r.timerState === 'overdue') overdue++;
    else if (['due_soon', 'running'].includes(r.timerState) && dayKey(Date.parse(r.timer.dueAt)) === today) dueToday++;
    if (r.status === 'fast_tracked') fastTracked++;
  }
  return { open, dueToday, overdue, fastTracked };
}

/** Apply the status and severity filters ('all' keeps everything). */
export function filterRows(rows, { status = 'all', severity = 'all' } = {}) {
  return rows.filter((r) => (status === 'all' || r.status === status) && (severity === 'all' || r.severityBand === severity));
}

/** Distinct statuses present, in first-seen order (drives the status filter options). */
export function statusOptions(rows) {
  return [...new Set(rows.map((r) => r.status).filter(Boolean))];
}
