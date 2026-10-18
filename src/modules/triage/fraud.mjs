// Fraud signals: deterministic indicators always run; AI indicators are unioned by code (max weight).
// Weights are 0-1 (schema). Score = capped sum of weights scaled to 0-100.
const w = (n) => Math.max(0, Math.min(1, Math.round(n * 100) / 100));

export const DEFAULTS = { inceptionDays: 30, lateReportDays: 14, priorClaims: 2, roundMin: 1000, roundStep: 500, siuScore: 60 };

/**
 * Deterministic indicators. Each is independent and testable on its own.
 * @param {object} f normalized facts
 * @param {object} [cfg] threshold overrides (tenant config triage.fraud)
 * @returns {{code: string, weight: number, reason: string}[]}
 */
export function deterministicIndicators(f, cfg = {}) {
  const t = { ...DEFAULTS, ...cfg };
  const out = [];
  const push = (code, weight, reason) => out.push({ code, weight: w(weight), reason });

  if (f.daysFromInception !== null && f.daysFromInception !== undefined && f.daysFromInception >= 0 && f.daysFromInception <= t.inceptionDays) {
    push('LOSS_NEAR_INCEPTION', 0.25, `Loss occurred ${f.daysFromInception} day(s) after policy inception.`);
  }
  if (f.daysToReport !== null && f.daysToReport !== undefined && f.daysToReport > t.lateReportDays) {
    push('LATE_REPORT', 0.15, `Reported ${f.daysToReport} days after the loss.`);
  }
  if ((f.cause === 'theft' || (f.cause == null && f.narrative?.theftCue)) && !f.policeReportFiled) {
    push('NO_POLICE_REPORT_THEFT', 0.3, 'Theft reported without a police report.');
  }
  if ((f.priorClaims ?? 0) >= t.priorClaims) {
    push('PRIOR_CLAIMS', 0.1 + Math.min(0.1, (f.priorClaims - t.priorClaims) * 0.05), `${f.priorClaims} prior claims on record.`);
  }
  if (f.narrative?.areaMismatch || f.lossDateMismatch) {
    const why = f.narrative?.areaMismatch ? 'Narrative damage areas do not match the damage areas in the evidence.' : 'Loss date in the documents differs from the reported loss date.';
    push('NARRATIVE_EVIDENCE_MISMATCH', 0.2, why);
  }
  if (typeof f.estimateTotal === 'number' && f.estimateTotal >= t.roundMin && f.estimateTotal % t.roundStep === 0) {
    push('ROUND_NUMBER_ESTIMATE', 0.1, `Estimate total ${f.estimateTotal} is a round number.`);
  }
  return out;
}

/** AI weights may arrive as 0-1 or as points (0-100); normalize to 0-1. */
const normWeight = (x) => (x === undefined || x === null || !Number.isFinite(Number(x)) ? 0.2 : Number(x) > 1 ? Number(x) / 100 : Number(x));

/**
 * @param {object[]} det deterministic indicators
 * @param {{indicators?: object[]}|null} ai fraud_signals output
 * @param {object} [cfg]
 * @returns {{score: number, indicators: object[], referToSiu: boolean}}
 */
export function mergeFraud(det, ai, cfg = {}) {
  const t = { ...DEFAULTS, ...cfg };
  const byCode = new Map();
  for (const i of det) byCode.set(i.code, { ...i });
  for (const raw of ai?.indicators ?? []) {
    if (!raw?.code) continue;
    const cand = { code: String(raw.code), weight: w(normWeight(raw.weight)), reason: raw.reason ?? 'Flagged by AI review.' };
    const cur = byCode.get(cand.code);
    if (!cur || cand.weight > cur.weight) byCode.set(cand.code, cur ? { ...cand, reason: cur.reason } : cand);
  }
  const indicators = [...byCode.values()].sort((a, b) => b.weight - a.weight || a.code.localeCompare(b.code));
  const score = Math.max(0, Math.min(100, Math.round(indicators.reduce((s, i) => s + i.weight, 0) * 100)));
  return { score, indicators, referToSiu: score >= t.siuScore };
}
