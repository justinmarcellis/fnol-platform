// Rule-based flags and next best actions. Pure functions over the aggregated read model.

const PRIORITY = { high: 3, medium: 2, low: 1 };

/**
 * Sort rank for a priority (higher sorts first). Rule actions use high | medium | low. AI actions use the
 * AI contract's ordinal where 1 is the highest (src/ai/providers/_shared.mjs), so 1 ranks with high,
 * 2 with medium and 3 or more with low, with finer steps inside a band. Numbers above 10 are read as a
 * 0-100 urgency score (higher is more urgent) for producers that score instead of ranking.
 */
export function priorityRank(p) {
  if (typeof p === 'number' && Number.isFinite(p)) {
    if (p > 10) return p >= 70 ? 3 : p >= 40 ? 2 : 1 - (40 - p) / 100;
    return Math.max(0, 4 - p) - (p >= 3 ? (p - 3) / 10 : 0);
  }
  return PRIORITY[p] ?? 1;
}

/** Band (high | medium | low) for any priority; the shape the contract's enum and the UI use. */
export function priorityBand(p) {
  const r = priorityRank(p);
  return r >= 3 ? 'high' : r >= 2 ? 'medium' : 'low';
}

const TERMINAL = ['closed', 'withdrawn'];
/** True when the claim is closed or withdrawn (read-only: no next best actions). */
export const isTerminal = (claim) => TERMINAL.includes(claim?.status);

/** Derived flags (strings) merged into claim.flags in the view. */
export function deriveFlags({ claim, triage, coverage, timers = [] }) {
  const f = [...(claim?.flags ?? [])];
  if (triage?.fraud?.referToSiu || (triage?.fraud?.score ?? 0) >= 70) f.push('siu');
  if (triage?.subrogation?.flag) f.push('subrogation');
  if (coverage && ['not_covered', 'partial', 'needs_review', 'policy_not_found'].includes(coverage.outcome)) f.push('coverage_question');
  if (timers.some((t) => t.status === 'due_soon')) f.push('timer_due');
  if (timers.some((t) => t.status === 'breached')) f.push('timer_breached');
  const le = claim?.lossEvent ?? {};
  if (le.injuriesReported) f.push('injury');
  if (le.fatality) f.push('fatality');
  if (le.catastropheCode) f.push('cat');
  return [...new Set(f)];
}

/** A police report is on file when a police_report document exists or the loss event records one as filed. */
export const hasPoliceReport = (le = {}, docs = []) => docs.some((d) => d.kind === 'police_report')
  || !!(le.policeReport && (le.policeReport === true || le.policeReport.filed === true || le.policeReport.number || le.policeReport.reportNumber));

/** Rule-based next best actions: [{code,label,reason,priority,source:'rule'}]. */
export function ruleActions({ claim, triage, coverage, timers = [], documents = [] }) {
  const out = [];
  const add = (code, label, reason, priority) => out.push({ code, label, reason, priority, source: 'rule' });
  const le = claim?.lossEvent ?? {};
  if ((claim?.lob ?? '').includes('auto') && le.cause !== 'glass' && !hasPoliceReport(le, documents)) {
    add('request_police_report', 'Request the police report', 'No police report on file for an auto loss', 'medium');
  }
  if (!coverage || ['pending', 'needs_review', 'policy_not_found'].includes(coverage.outcome)) {
    add('verify_coverage', 'Verify coverage manually', coverage ? `Coverage outcome is ${coverage.outcome}` : 'Coverage has not been verified', 'high');
  } else if (coverage.outcome === 'not_covered') {
    add('review_coverage_denial', 'Review coverage position', 'Coverage check found the loss not covered', 'high');
  }
  for (const t of timers) {
    if (t.status === 'breached') add(`timer_${t.kind}_breached`, `Regulatory ${t.kind} deadline missed`, `Timer ${t.kind} breached; act now and document`, 'high');
    else if (t.status === 'due_soon') add(`timer_${t.kind}_due`, `Complete ${t.kind} step`, `Regulatory ${t.kind} timer is due ${t.dueAt ?? 'soon'}`, 'high');
  }
  if (triage?.fraud?.referToSiu || (triage?.fraud?.score ?? 0) >= 70) {
    add('refer_siu', 'Review SIU referral', `Fraud score ${triage.fraud.score}`, 'high');
  }
  if (triage?.subrogation?.flag) add('review_subrogation', 'Review subrogation potential', 'Triage flagged possible recovery', 'medium');
  if (le.injuriesReported) add('contact_injured_party', 'Contact injured party', 'Injury reported at first notice', 'high');
  return out;
}

const codeKey = (c) => String(c ?? '').toLowerCase();

/**
 * Merge rule and AI actions: dedupe by code, case-insensitively (rule wins), highest priority first.
 * Every AI row carries `ai` provenance (provider, model, confidence) from the run that produced it, and
 * its priority is normalised to high | medium | low; the AI's own ordinal is kept as `aiPriority`.
 * @param {object[]} rules
 * @param {object[]} [ai]
 * @param {object} [provenance] AiProvenance of the next_best_actions run
 */
export function mergeActions(rules, ai = [], provenance) {
  const seen = new Set();
  const aiRows = ai.map((a) => ({
    ...a,
    source: 'ai',
    ...(a?.priority !== undefined ? { priority: priorityBand(a.priority), aiPriority: a.priority } : {}),
    ...(provenance && !a?.ai ? { ai: provenance } : {}),
    _rank: priorityRank(a?.priority),
  }));
  const all = [...rules.map((r) => ({ ...r, _rank: priorityRank(r.priority) })), ...aiRows].filter((a) => {
    if (!a?.code || seen.has(codeKey(a.code))) return false;
    seen.add(codeKey(a.code));
    return true;
  });
  return all.map((a, i) => ({ a, i })).sort((x, y) => y.a._rank - x.a._rank || x.i - y.i).map(({ a }) => {
    const { _rank, ...rest } = a;
    return rest;
  });
}
