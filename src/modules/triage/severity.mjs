// Severity: AI score plus rule add_severity deltas, clamped 0-100, banded by thresholds.
const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));

/** Band names follow TriageResult.schema.json; cut-offs default to 25/50/75 and are tenant-overridable. */
export function bandFor(score, cuts = [25, 50, 75]) {
  const [a, b, c] = cuts;
  return score < a ? 'minor' : score < b ? 'moderate' : score < c ? 'major' : 'severe';
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
 * @param {object} facts normalized facts (baseline when ai is null)
 * @param {number[]} [cuts]
 * @returns {{score: number, band: string, drivers: string[], factors: object[]}}
 */
export function computeSeverity(ai, deltas, facts, cuts) {
  const base = ai && Number.isFinite(Number(ai.score)) ? { score: clamp(Number(ai.score)), drivers: ai.drivers ?? [], src: 'ai' } : { ...baselineSeverity(facts), src: 'baseline' };
  const factors = [{ name: base.src === 'ai' ? 'ai_severity' : 'baseline_severity', contribution: base.score, detail: base.drivers.join('; ') }];
  const drivers = [...base.drivers];
  let total = base.score;
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
