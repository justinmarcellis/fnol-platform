// Plain-language explanation for the adjuster, built from drivers (no PII).
const SIZE = { minor: 'a minor', moderate: 'a moderate', major: 'a major', severe: 'a severe' };

/**
 * @returns {string} two to five sentences
 */
export function explain({ severity, complexity, fraud, subrogation, degraded }) {
  const s = [];
  const drivers = severity.drivers.filter(Boolean).slice(0, 3);
  s.push(`This looks like ${SIZE[severity.band] ?? 'a'} loss with a severity score of ${severity.score} out of 100${drivers.length ? `, driven by ${drivers.join(', ')}` : ''}.`);
  s.push(`Handling complexity is ${complexity.complexity}${complexity.reasons.length ? ` because ${complexity.reasons.slice(0, 2).join(' and ')}` : ''}.`);
  if (fraud.indicators.length) {
    s.push(`Fraud score is ${fraud.score} out of 100 from ${fraud.indicators.length} indicator(s): ${fraud.indicators.slice(0, 3).map((i) => i.reason.replace(/\.$/, '')).join('; ')}.${fraud.referToSiu ? ' This meets the threshold for special investigations review.' : ''}`);
  } else {
    s.push('No fraud indicators were found.');
  }
  s.push(subrogation.flag
    ? `Subrogation potential is flagged: ${subrogation.reasons.slice(0, 2).map((r) => r.reason.replace(/\.$/, '')).join('; ')}.`
    : 'No subrogation opportunity was identified.');
  if (degraded) s.push('The AI service was unavailable, so this assessment uses built-in rules only and should be reviewed.');
  return s.join(' ');
}
