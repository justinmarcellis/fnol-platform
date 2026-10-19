// Rule-based flags and next best actions. Pure functions over the aggregated read model.

const PRIORITY = { high: 3, medium: 2, low: 1 };
const rank = (p) => (typeof p === 'number' ? p : PRIORITY[p] ?? 1);

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

const hasPoliceReport = (le, docs) => docs.some((d) => d.kind === 'police_report')
  || (le.policeReport && (le.policeReport === true || le.policeReport.number || le.policeReport.reportNumber));

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

/** Merge rule and AI actions: dedupe by code (rule wins), highest priority first. */
export function mergeActions(rules, ai = []) {
  const seen = new Set();
  const all = [...rules, ...ai.map((a) => ({ ...a, source: 'ai' }))].filter((a) => {
    if (!a?.code || seen.has(a.code)) return false;
    seen.add(a.code);
    return true;
  });
  return all.map((a, i) => ({ a, i })).sort((x, y) => rank(y.a.priority) - rank(x.a.priority) || x.i - y.i).map((x) => x.a);
}
