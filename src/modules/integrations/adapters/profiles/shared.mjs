import { causeCode, lobCode } from '../codes.mjs';

export const PII = '[pii]';

/** Wrap PII values: masked in previews, real when sending. */
export const piiOf = (maskPii) => (v) => (maskPii && v !== undefined && v !== null && v !== '' ? PII : v);

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 'YYYY-MM-DD' (or ISO timestamp) -> 'YYYYMMDD'. */
export const compactDate = (d) => (d ? String(d).slice(0, 10).replaceAll('-', '') : undefined);

/** ISO timestamp -> 'YYYYMMDDHHMMSS' (UTC). */
export function compactTimestamp(iso) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** 'HH:MM' -> 'HHMM'. */
export const compactTime = (t) => (t ? String(t).replace(':', '') : undefined);

/** Drop undefined keys (shallow) so payloads only carry what exists. */
export function clean(obj) {
  const isEmptyObject = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && !isEmptyObject(v)));
}

/**
 * Pieces every profile needs, resolved once: LOB code, cause code, matched coverages and warnings.
 */
export function resolveCommon(input, profile, warnings, { lob: lobId, cause: lossCause, policyNumber }) {
  const { config, settings = {}, coverage, snapshot } = input;
  const lob = lobCode(lobId, config);
  if (lob.warning) warnings.push(lob.warning);
  const cause = causeCode(profile, lossCause, settings.causeCodes);
  if (cause.warning) warnings.push(cause.warning);
  if (!policyNumber) warnings.push('claim has no policyNumber');
  if (!coverage) warnings.push('no coverage verification available; coverage section omitted');
  else if (!snapshot) warnings.push('policy snapshot unavailable; policy term and coverages omitted');
  const matched = new Set(coverage?.matchedCoverages ?? coverage?.applicableCoverages ?? []);
  const covs = (snapshot?.coverages ?? []).filter((c) => matched.size === 0 || matched.has(c.code));
  return { lobCd: lob.code, causeCd: cause.code, coverages: covs };
}

/** Flat triage facts shared by both profiles' extension aggregates. */
export function triageFacts(input, warnings) {
  const t = input.triage;
  if (!t) {
    warnings.push('no triage result available; triage extension omitted');
    return null;
  }
  return clean({
    severityScore: t.severityScore,
    severityBand: t.severityBand,
    complexity: t.complexity,
    fraudScore: t.fraud?.score,
    referToSiu: t.fraud?.referToSiu,
    subrogation: t.subrogation?.flag,
    fastTrackEligible: t.fastTrackEligible,
    provider: t.ai?.provider,
    model: t.ai?.model,
    confidence: t.ai?.confidence,
  });
}
