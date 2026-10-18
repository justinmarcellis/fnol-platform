// Normalized, PII-free facts for triage. The narrative is reduced to boolean cues; names,
// plates, addresses and free text never leave this function.
import { createHash } from 'node:crypto';

const DAY = 86400000;
const toDay = (s) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s ?? ''));
  return m ? m[1] : null;
};
/** Whole days from date a to date b (YYYY-MM-DD or ISO), or null. */
export function daysBetween(a, b) {
  const x = toDay(a); const y = toDay(b);
  if (!x || !y) return null;
  return Math.round((Date.parse(`${y}T00:00:00Z`) - Date.parse(`${x}T00:00:00Z`)) / DAY);
}

/** Canonical JSON (sorted keys, undefined dropped) so equal facts always hash equal. */
export function canonicalJson(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}
export const sha256 = (v) => createHash('sha256').update(canonicalJson(v)).digest('hex');

const AREA_WORDS = [
  ['rear', /\b(rear|back|trunk|tailgate|bumper from behind)\b/],
  ['front', /\b(front|hood|grille|headlight)\b/],
  ['left', /\b(left|driver'?s? side|driver door)\b/],
  ['right', /\b(right|passenger'?s? side|passenger door)\b/],
  ['roof', /\broof\b/],
  ['glass', /\b(windshield|windscreen|window|glass)\b/],
  ['undercarriage', /\b(undercarriage|underbody)\b/],
];
/** Map free text (or an array of area names) to a sorted list of canonical areas. */
export function areasIn(text) {
  const s = (Array.isArray(text) ? text.join(' ') : String(text ?? '')).toLowerCase();
  return AREA_WORDS.filter(([, re]) => re.test(s)).map(([k]) => k).sort();
}

const RE = {
  rearEnded: /rear[- ]?ended|from behind|hit in the rear/i,
  selfRearEnd: /\b(i|we) (rear[- ]?ended|hit the (car|vehicle|truck) (in front|ahead)|ran into the back)/i,
  insuredFault: /\b(my fault|i (was at fault|caused|ran|failed|backed into|hit|struck|slid)|we (caused|hit|ran into))\b/i,
  otherFault: /(other (driver|party|vehicle|motorist)|another (driver|vehicle|car)|a (driver|car|truck)).{0,60}(ran|failed to|cut|swerved|hit|struck|crossed|was speeding|rear[- ]?ended|backed into)|not my fault|at fault was the other/i,
  theft: /\b(stolen|theft|broke into|break[- ]in|burglar)/i,
};

const num = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return num(v.amount ?? v.value);
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && String(v).match(/\d/) ? n : null;
};
const val = (accepted, name) => {
  const f = accepted?.[name];
  return f && typeof f === 'object' && 'value' in f ? f.value : f;
};
const str = (v) => (v === null || v === undefined ? '' : String(typeof v === 'object' ? (v.name ?? v.party ?? v.role ?? '') : v)).trim();
const INSURED = /\b(insured|policyholder|my|me|self|first party|first-party|our)\b/i;

/** Classify a party label: 'insured' | 'other' | 'unknown'. */
export function partySide(raw) {
  const s = str(raw);
  if (!s) return 'unknown';
  if (/^(other|third|adverse|claimant|at[- ]?fault other)/i.test(s) || /other (driver|party)/i.test(s)) return 'other';
  if (INSURED.test(s)) return 'insured';
  return 'other'; // a named non-insured driver
}

/**
 * Build the normalized facts object.
 * @param {{bundle?: object, accepted?: object, verification?: object|null, policy?: object|null, priorClaims?: number|null}} src
 * @returns {object} PII-free facts; stable for hashing (no clocks, ids or free text)
 */
export function buildTriageFacts({ bundle, accepted = {}, verification = null, policy = null, priorClaims = null } = {}) {
  const claim = bundle?.claim ?? {};
  const loss = claim.lossEvent ?? {};
  const parties = bundle?.parties ?? claim.parties ?? [];
  const vehicles = bundle?.vehicles ?? claim.vehicles ?? [];
  const text = String(loss.description ?? '');

  const lossDate = toDay(loss.lossDate);
  const acceptedLossDate = toDay(val(accepted, 'lossDate'));
  const reportedDate = toDay(claim.reportedAt);
  const inception = toDay(policy?.period?.effectiveDate ?? verification?.policyEffectiveDate ?? claim.policyEffectiveDate);

  const estimate = num(val(accepted, 'estimateTotal'));
  const evidenceAreas = areasIn(val(accepted, 'damageAreas'));
  const narrativeAreas = areasIn(text);
  const policeNumber = str(val(accepted, 'policeReportNumber')) || str(loss.policeReport?.reportNumber);
  const policeFiled = loss.policeReport?.filed === true || !!policeNumber;
  const citedRaw = val(accepted, 'citedParty');
  const atFaultRaw = val(accepted, 'atFaultParty');
  const cause = loss.cause ?? null;
  const injured = parties.filter((p) => p?.injured === true).length;
  const failed = (verification?.checks ?? []).filter((c) => c && c.passed === false).map((c) => c.code).filter(Boolean).sort();
  const prior = priorClaims ?? bundle?.priorClaimsCount ?? (Array.isArray(bundle?.priorClaims) ? bundle.priorClaims.length : null)
    ?? claim.priorClaimsCount ?? (Number.isFinite(Number(val(accepted, 'priorClaims'))) ? Number(val(accepted, 'priorClaims')) : null);

  return {
    lob: claim.lob ?? null,
    lossType: claim.lossType ?? null,
    cause,
    riskState: claim.riskState ?? null,
    lossDate,
    reportedDate,
    daysToReport: daysBetween(lossDate, reportedDate),
    inceptionDate: inception,
    daysFromInception: daysBetween(inception, lossDate),
    priorClaims: prior ?? 0,
    injuries: loss.injuriesReported === true || injured > 0,
    injuredCount: injured,
    fatality: loss.fatality === true,
    vehiclesInvolved: Number.isInteger(loss.vehiclesInvolved) ? loss.vehiclesInvolved : vehicles.length,
    partyCount: parties.length,
    policeReportFiled: policeFiled,
    policeReportNumber: policeNumber ? 'on_file' : undefined,
    estimateTotal: estimate ?? undefined,
    repairShopKnown: !!str(val(accepted, 'repairShop')),
    vinKnown: !!str(val(accepted, 'vin')),
    damageAreas: evidenceAreas,
    citedParty: citedRaw ? partySide(citedRaw) : undefined,
    atFaultParty: atFaultRaw ? partySide(atFaultRaw) : undefined,
    acceptedLossDate: acceptedLossDate ?? undefined,
    lossDateMismatch: !!(lossDate && acceptedLossDate && lossDate !== acceptedLossDate),
    coverage: verification
      ? { outcome: verification.outcome ?? null, status: verification.status ?? null, failedChecks: failed }
      : null,
    narrative: {
      present: text.length > 0,
      areas: narrativeAreas,
      areaMismatch: narrativeAreas.length > 0 && evidenceAreas.length > 0 && !narrativeAreas.some((a) => evidenceAreas.includes(a)),
      rearEndedByOther: RE.rearEnded.test(text) && !RE.selfRearEnd.test(text),
      insuredAtFaultCue: RE.insuredFault.test(text) || RE.selfRearEnd.test(text),
      otherAtFaultCue: RE.otherFault.test(text) && !RE.insuredFault.test(text),
      theftCue: RE.theft.test(text),
    },
  };
}
