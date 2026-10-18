// Pure coverage rules: (policy snapshot, claim loss facts) -> verdict.
// No I/O, no clock, no PII in the output, so it is table-testable.
//
// Verdict status (module-level, richer than the persisted outcome):
//   in_force | lapsed | not_found | excluded | needs_review
// mapped to CoverageVerification.outcome by OUTCOME_BY_STATUS.
// Indicative only: the carrier makes the coverage decision.

export const OUTCOME_BY_STATUS = {
  in_force: 'covered',
  lapsed: 'not_covered',
  excluded: 'not_covered',
  not_found: 'policy_not_found',
  needs_review: 'needs_review',
};

const AUTO_CAUSES = {
  collision: ['COLL'],
  single_vehicle: ['COLL'],
  hit_and_run: ['COLL', 'UM'],
  collision_animal: ['COMP'],
  glass: ['GLASS', 'COMP'], // glass is a comprehensive sub-coverage; standalone GLASS wins when present
  theft: ['COMP'],
  vandalism: ['COMP'],
  fire: ['COMP'],
  lightning: ['COMP'],
  wind: ['COMP'],
  hail: ['COMP'],
  water_weather: ['COMP'],
  water_plumbing: ['COMP'],
  flood: ['COMP'],
  freeze: ['COMP'],
  falling_object: ['COMP'],
  liability_bodily_injury: ['BI'],
  liability_property_damage: ['PD'],
};

const PROPERTY_PERILS = ['DWELLING', 'OTHER_STRUCTURES', 'PERSONAL_PROPERTY'];
const HOME_CAUSES = Object.fromEntries([
  'collision', 'single_vehicle', 'hit_and_run', 'collision_animal', 'vandalism', 'fire', 'lightning', 'wind', 'hail',
  'water_weather', 'water_plumbing', 'flood', 'freeze', 'falling_object',
].map((c) => [c, PROPERTY_PERILS]));
Object.assign(HOME_CAUSES, {
  theft: ['PERSONAL_PROPERTY', 'DWELLING'],
  glass: ['DWELLING'],
  liability_bodily_injury: ['PERSONAL_LIABILITY', 'MED_PAY_OTHERS'],
  liability_property_damage: ['PERSONAL_LIABILITY'],
});

/** Auto or property family of a tenant LOB id (personal_auto, commercial_auto, homeowners, renters ...). */
export function lobFamily(lob) {
  const s = String(lob ?? '').toLowerCase();
  if (s.includes('auto')) return 'auto';
  if (/home|renter|condo|dwelling|property/.test(s)) return 'property';
  return null;
}

const money = (m) => (m ? { amount: m.amount, currency: m.currency ?? 'USD' } : null);

/** Deductible of a coverage; percent_of_dwelling deductibles are amount-as-percent of the DWELLING limit. */
function deductibleOf(cov, policy) {
  if (!cov.deductible) return null;
  if (cov.deductibleType === 'percent_of_dwelling') {
    const dwelling = (policy.properties ?? []).flatMap((p) => p.coverages ?? []).concat(policy.coverages ?? [])
      .find((c) => c.code === 'DWELLING' && c.limit);
    if (!dwelling) return null;
    return { amount: Math.round(dwelling.limit.amount * cov.deductible.amount) / 100, currency: dwelling.limit.currency ?? 'USD' };
  }
  return money(cov.deductible);
}

const limitsOf = (cov) => {
  const o = {};
  for (const k of ['limit', 'limitPerPerson', 'limitPerOccurrence']) if (cov[k]) o[k] = money(cov[k]);
  return o;
};

/**
 * @typedef {object} LossFacts
 * @property {string} [policyNumber]
 * @property {string} lob claim LOB id
 * @property {string} lossDate YYYY-MM-DD, already in the tenant time zone
 * @property {string} lossCause platform LossCause code
 * @property {{ role?: string, vin?: string, policyVehicleId?: string }[]} [vehicles]
 * @property {{ role?: string, policyLocationId?: string }[]} [properties]
 */

/**
 * Evaluate a claim against a policy snapshot.
 * @param {object|null} policy PolicySnapshot (null or status not_found when the policy does not exist)
 * @param {LossFacts} facts
 * @returns {{ status: string, outcome: string, reasons: string[], checks: object[], deductible: object|null,
 *   limits: object, applicableCoverages: string[], lossInPeriod: boolean|null }}
 */
export function evaluateCoverage(policy, facts) {
  const checks = [];
  const reasons = [];
  const done = (status, extra = {}) => ({
    status,
    outcome: OUTCOME_BY_STATUS[status],
    reasons,
    checks,
    deductible: null,
    limits: {},
    applicableCoverages: [],
    lossInPeriod: null,
    ...extra,
  });
  const check = (code, passed, detail) => checks.push(detail ? { code, passed, detail } : { code, passed });

  // 1. Policy exists
  if (!facts.policyNumber) {
    reasons.push('no_policy_number: claim has no policy number to verify');
    return done('needs_review');
  }
  if (!policy || policy.status === 'not_found') {
    check('policy_found', false, 'policy number not found in policy system');
    reasons.push('policy_not_found: no policy matches the reported policy number');
    return done('not_found');
  }
  check('policy_found', true);

  // 2. Term and status (policy status is as of the loss date)
  const { effectiveDate, expirationDate, cancellationDate } = policy.period;
  const end = cancellationDate && cancellationDate < expirationDate ? cancellationDate : expirationDate;
  const lossInPeriod = facts.lossDate >= effectiveDate && facts.lossDate < end;
  check('loss_in_period', lossInPeriod, `${effectiveDate} to ${end}`);
  const statusOk = policy.status === 'in_force' || policy.status === 'pending_cancellation';
  check('in_force', statusOk, `policy status ${policy.status}`);
  if (!lossInPeriod) {
    reasons.push(facts.lossDate < effectiveDate
      ? 'loss_before_effective_date: loss date is before the policy effective date'
      : 'loss_after_policy_end: loss date is on or after the policy expiration or cancellation date');
    return done('lapsed', { lossInPeriod });
  }
  if (!statusOk) {
    reasons.push(`policy_not_in_force: policy status is ${policy.status} on the loss date`);
    return done('lapsed', { lossInPeriod });
  }
  if (policy.status === 'pending_cancellation') reasons.push('pending_cancellation: policy was in force on the loss date but cancellation is pending');

  // 3. Line of business
  const family = lobFamily(policy.lob);
  if (policy.lob !== facts.lob) {
    check('coverage_present', false, 'line of business mismatch');
    reasons.push(`lob_mismatch: claim LOB ${facts.lob} differs from policy LOB ${policy.lob}`);
    return done('needs_review', { lossInPeriod });
  }
  if (!family) {
    reasons.push(`unsupported_lob: no coverage rules for LOB ${policy.lob}`);
    return done('needs_review', { lossInPeriod });
  }

  // 4. Insured unit(s) on the policy
  let unitCoverages = [];
  let unitId = null;
  if (family === 'auto') {
    const claimed = (facts.vehicles ?? []).filter((v) => !v.role || v.role === 'insured');
    if (!claimed.length) {
      reasons.push('no_insured_vehicle: claim does not identify an insured vehicle');
      return done('needs_review', { lossInPeriod });
    }
    const matches = claimed.map((cv) => (policy.vehicles ?? []).find((pv) => (cv.policyVehicleId && cv.policyVehicleId === pv.unitId)
      || (cv.vin && pv.vin && cv.vin.toUpperCase() === pv.vin.toUpperCase())));
    const hit = matches.filter(Boolean);
    check('vehicle_on_policy', hit.length === claimed.length, `${hit.length} of ${claimed.length} insured vehicles matched`);
    if (!hit.length) {
      reasons.push('vehicle_not_on_policy: the insured vehicle is not listed on the policy');
      return done('excluded', { lossInPeriod });
    }
    if (hit.length < claimed.length) {
      reasons.push('vehicle_partly_on_policy: some reported insured vehicles are not listed on the policy');
      return done('needs_review', { lossInPeriod });
    }
    unitId = hit[0].unitId;
    unitCoverages = hit[0].coverages ?? [];
  } else {
    const claimed = (facts.properties ?? []).filter((p) => !p.role || p.role === 'insured_location');
    const locations = policy.properties ?? [];
    if (!claimed.length) {
      if (locations.length === 1) {
        unitId = locations[0].locationId;
        unitCoverages = locations[0].coverages ?? [];
        check('location_on_policy', true, 'only location on the policy assumed');
      } else {
        reasons.push('no_insured_location: claim does not identify which insured location was affected');
        return done('needs_review', { lossInPeriod });
      }
    } else {
      const matches = claimed.map((cp) => locations.find((l) => cp.policyLocationId && cp.policyLocationId === l.locationId));
      const hit = matches.filter(Boolean);
      check('location_on_policy', hit.length === claimed.length, `${hit.length} of ${claimed.length} locations matched`);
      if (!hit.length) {
        reasons.push('location_not_on_policy: the loss location is not an insured location on the policy');
        return done('excluded', { lossInPeriod });
      }
      if (hit.length < claimed.length) {
        reasons.push('location_partly_on_policy: some reported locations are not insured locations on the policy');
        return done('needs_review', { lossInPeriod });
      }
      unitId = hit[0].locationId;
      unitCoverages = hit[0].coverages ?? [];
    }
  }

  // 5. Peril -> coverage codes
  const table = family === 'auto' ? AUTO_CAUSES : HOME_CAUSES;
  const candidates = table[facts.lossCause];
  if (!candidates) {
    reasons.push(`cause_not_mapped: loss cause ${facts.lossCause} needs a person to assess`);
    return done('needs_review', { lossInPeriod });
  }
  const policyLevel = (policy.coverages ?? []).filter((c) => !c.appliesToUnitIds || !unitId || c.appliesToUnitIds.includes(unitId));
  const available = [...unitCoverages, ...policyLevel];

  // Standard homeowners exclusion: flood is not covered unless the FLOOD endorsement is present.
  const floodExcluded = family === 'property' && facts.lossCause === 'flood'
    && !(policy.endorsements ?? []).some((e) => e.code === 'FLOOD');

  const present = candidates.map((code) => available.find((c) => c.code === code)).filter(Boolean);
  const perilExcluded = floodExcluded ? present : present.filter((c) => (c.excludedPerils ?? []).includes(facts.lossCause));
  const matched = floodExcluded ? [] : present.filter((c) => !perilExcluded.includes(c));

  check('coverage_present', present.length > 0, candidates.join(' or '));
  if (!present.length) {
    reasons.push(`coverage_not_purchased: no ${candidates.join(' / ')} coverage on the policy for ${facts.lossCause}`);
    return done('excluded', { lossInPeriod });
  }
  check('peril_covered', matched.length > 0, facts.lossCause);
  if (!matched.length) {
    reasons.push(floodExcluded
      ? 'flood_excluded: flood is excluded unless the flood endorsement is on the policy'
      : `peril_excluded: ${facts.lossCause} is excluded under ${perilExcluded.map((c) => c.code).join(', ')}`);
    return done('excluded', { lossInPeriod });
  }

  let deductible = null;
  for (const c of matched) {
    deductible = deductibleOf(c, policy);
    if (deductible) break;
  }
  const limits = {};
  for (const c of matched) limits[c.code] = limitsOf(c);
  reasons.push(`covered_under: ${matched.map((c) => c.code).join(', ')}`);
  return done('in_force', { lossInPeriod, deductible, limits, applicableCoverages: matched.map((c) => c.code) });
}
