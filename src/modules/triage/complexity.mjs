// Claim complexity from parties, injuries, coverage issues and rule overrides.
const ORDER = ['low', 'medium', 'high'];

/**
 * @param {object} facts normalized facts
 * @param {string[]} [ruleSet] values from set_complexity actions
 * @param {{ band?: string }} [severity] computed severity: a major or severe loss is never low complexity (ADJUSTER-18)
 * @returns {{ complexity: 'low'|'medium'|'high', points: number, reasons: string[] }}
 */
export function computeComplexity(facts, ruleSet = [], severity = null) {
  let points = 0;
  const reasons = [];
  const add = (n, why) => { points += n; reasons.push(why); };
  if (facts.partyCount > 2) add(1, `${facts.partyCount} parties involved`);
  if ((facts.vehiclesInvolved ?? 0) > 2) add(1, `${facts.vehiclesInvolved} vehicles involved`);
  if (facts.fatality) add(2, 'a fatality was reported');
  else if (facts.injuries) add(1, 'injuries were reported');
  if (facts.coverage && facts.coverage.outcome && facts.coverage.outcome !== 'covered') add(1, `coverage outcome is ${facts.coverage.outcome}`);
  else if (facts.coverage?.failedChecks?.length) add(1, 'coverage checks need review');
  if (facts.lossDateMismatch) add(1, 'loss date differs between report and documents');
  if (severity?.band === 'severe') add(2, 'severity is severe');
  else if (severity?.band === 'major') add(1, 'severity is major');
  let complexity = points >= 3 ? 'high' : points >= 1 ? 'medium' : 'low';
  const set = ruleSet.filter((c) => ORDER.includes(c));
  if (set.length) {
    const top = set.reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a));
    if (ORDER.indexOf(top) > ORDER.indexOf(complexity)) reasons.push(`rules set complexity to ${top}`);
    complexity = ORDER.indexOf(top) > ORDER.indexOf(complexity) ? top : complexity;
    if (set.length && !reasons.some((r) => r.startsWith('rules'))) reasons.push(`rules kept complexity at ${complexity}`);
  }
  return { complexity, points, reasons };
}
