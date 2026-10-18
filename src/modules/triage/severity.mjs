// Severity: AI score (or deterministic baseline) plus platform calibration plus rule add_severity deltas,
// clamped 0-100 and banded by thresholds. Calibrated against tests/synthetic scenarios per ADR-003.
const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));

/** Default band cut-offs (ADR-003): 0-24 minor, 25-49 moderate, 50-74 major, 75-100 severe. */
export const DEFAULT_CUTS = Object.freeze([25, 50, 75]);

/**
 * Normalize tenant band cut-offs. Accepts the TenantConfig shape `{ moderate, major, severe }` or an array
 * `[moderate, major, severe]`; anything missing or not strictly ascending falls back to the defaults.
 * @param {number[]|{moderate?: number, major?: number, severe?: number}|null|undefined} bands
 * @returns {number[]}
 */
export function bandCuts(bands) {
  const raw = Array.isArray(bands) ? bands : bands && typeof bands === 'object' ? [bands.moderate, bands.major, bands.severe] : [];
  const cuts = DEFAULT_CUTS.map((d, i) => (Number.isFinite(Number(raw[i])) && raw[i] !== null ? Number(raw[i]) : d));
  return cuts[0] < cuts[1] && cuts[1] < cuts[2] ? cuts : [...DEFAULT_CUTS];
}

/** Band names follow TriageResult.schema.json; cut-offs default to 25/50/75 and are tenant-overridable. */
export function bandFor(score, cuts = DEFAULT_CUTS) {
  const [a, b, c] = bandCuts(cuts);
  return score < a ? 'minor' : score < b ? 'moderate' : score < c ? 'major' : 'severe';
}

/**
 * Platform calibration weights for cues the AI severity pass does not see (claim child records, LOB).
 * Tenant rules should not repeat these with add_severity, or the driver is counted twice.
 */
export const CALIBRATION = Object.freeze({
  totalLossIndicated: 25,
  vehicleNotDrivable: 8,
  dwellingUninhabitable: 30,
  commercialLine: 10,
});

/**
 * Calibration adjustments from normalized facts.
 * @param {object} f normalized facts
 * @returns {{points: number, why: string}[]}
 */
export function calibrationAdjustments(f = {}) {
  const out = [];
  if (f.totalLossIndicated) out.push({ points: CALIBRATION.totalLossIndicated, why: 'vehicle total loss or not recovered' });
  else if (f.vehicleNotDrivable) out.push({ points: CALIBRATION.vehicleNotDrivable, why: 'insured vehicle not drivable or towed' });
  if (f.dwellingUninhabitable) out.push({ points: CALIBRATION.dwellingUninhabitable, why: 'dwelling uninhabitable' });
  if (f.lob === 'commercial_auto') out.push({ points: CALIBRATION.commercialLine, why: 'commercial unit: loss-of-use and business exposure' });
  return out;
}

/**
 * Estimate-amount tiers (ADR-003, S3-ITG-01). Since S3-AI-01 the estimate is the grand total (parts + labor + tax),
 * about 1.9x the parts subtotal the original tiers were set against, so the platform cut-offs moved up with it.
 * AI_ESTIMATE_TIERS mirrors what the AI severity pass awards; the difference is applied as a calibration factor.
 */
export const ESTIMATE_TIERS = Object.freeze([{ min: 25000, points: 25 }, { min: 12500, points: 15 }, { min: 5000, points: 8 }]);
export const AI_ESTIMATE_TIERS = Object.freeze([{ min: 15000, points: 25 }, { min: 7500, points: 15 }, { min: 2500, points: 8 }]);
export function estimateTier(total, tiers) {
  const n = Number(total);
  return Number.isFinite(n) ? tiers.find((t) => n >= t.min) ?? null : null;
}

/** Deterministic baseline, used when the AI layer is unavailable. */
export function baselineSeverity(f) {
  let score = 5;
  const drivers = [];
  const add = (n, why) => { score += n; drivers.push(why); };
  if (f.fatality) add(60, 'fatality reported');
  if (f.injuries) add(35, 'injuries reported');
  if (f.cause === 'fire') add(40, 'fire loss');
  else if (['hail', 'flood', 'wind', 'water_weather'].includes(f.cause)) add(30, 'weather loss');
  else if (f.cause === 'theft') add(20, 'theft loss');
  else if (f.cause === 'glass') add(-5, 'glass-only loss');
  else if (/collision|single_vehicle|hit_and_run|liability/.test(f.cause ?? '')) add(10, 'collision loss');
  const tier = estimateTier(f.estimateTotal, ESTIMATE_TIERS);
  if (tier) add(tier.points, `estimate at or above $${tier.min.toLocaleString('en-US')}`);
  return { score: clamp(score), drivers };
}

/**
 * @param {{score?: number, drivers?: string[]}|null} ai severity output (null when unavailable)
 * @param {number[]} deltas add_severity points from rules
 * @param {object} facts normalized facts
 * @param {number[]|object} [cuts] band cut-offs (array or TenantConfig.severityBands)
 * @returns {{score: number, band: string, drivers: string[], factors: object[]}}
 */
export function computeSeverity(ai, deltas, facts, cuts) {
  const base = ai && Number.isFinite(Number(ai.score)) ? { score: clamp(Number(ai.score)), drivers: ai.drivers ?? [], src: 'ai' } : { ...baselineSeverity(facts), src: 'baseline' };
  const factors = [{ name: base.src === 'ai' ? 'ai_severity' : 'baseline_severity', contribution: base.score, detail: base.drivers.join('; ') }];
  const drivers = [...base.drivers];
  let total = base.score;
  const calib = calibrationAdjustments(facts);
  if (base.src === 'ai' && base.drivers.some((d) => /estimate at or above/.test(d))) {
    const diff = (estimateTier(facts?.estimateTotal, ESTIMATE_TIERS)?.points ?? 0) - (estimateTier(facts?.estimateTotal, AI_ESTIMATE_TIERS)?.points ?? 0);
    if (diff !== 0) calib.push({ points: diff, why: 'estimate tier re-based to grand total (parts + labor + tax)' });
  }
  for (const c of calib) {
    total += c.points;
    factors.push({ name: 'calibration', contribution: c.points, detail: c.why });
    drivers.push(c.why);
  }
  for (const d of deltas) {
    const n = Number(d);
    if (!Number.isFinite(n) || n === 0) continue;
    total += n;
    factors.push({ name: 'rule_add_severity', contribution: n, detail: `tenant rule adds ${n} points` });
    drivers.push(`tenant rule adds ${n} severity points`);
  }
  const score = clamp(total);
  return { score, band: bandFor(score, cuts), drivers, factors };
}
