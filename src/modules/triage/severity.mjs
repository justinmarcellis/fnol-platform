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
  if ((f.estimateTotal ?? 0) >= 15000) add(25, 'estimate at or above $15,000');
  else if ((f.estimateTotal ?? 0) >= 7500) add(15, 'estimate at or above $7,500');
  else if ((f.estimateTotal ?? 0) >= 2500) add(8, 'estimate at or above $2,500');
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
  for (const c of calibrationAdjustments(facts)) {
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
