import { ROLE_CODES } from '../codes.mjs';
import { createTracker } from '../tracker.mjs';
import { compactDate, compactTime, compactTimestamp, piiOf, resolveCommon, triageFacts } from './shared.mjs';

const yn = (v) => (v === undefined || v === null ? undefined : v ? 'Y' : 'N');

/**
 * Profile B (Kestrel-style): one flat object, UPPER_SNAKE keys, repeating groups as NAME_<n>_FIELD,
 * dates as YYYYMMDD, times as HHMM, indicators as Y/N, money as plain numbers.
 * @param {object} input see adapter.map
 * @returns {{ payload: object, unmapped: string[], warnings: string[] }}
 */
export function mapProfileB(input) {
  const warnings = [];
  const { view, unmapped } = createTracker(input.bundle);
  const p = piiOf(input.maskPii);
  const { lobCd, causeCd, coverages } = resolveCommon(input, 'B', warnings, { lob: view.get('claim.lob'), cause: view.get('claim.lossEvent.cause'), policyNumber: view.get('claim.policyNumber') });
  const triage = triageFacts(input, warnings);
  const out = {};
  const put = (key, value) => {
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  };

  put('RQ_UID', input.rqUid);
  put('REQUEST_TS', compactTimestamp(input.now));
  put('CLAIM_REF', view.get('claim.claimNumber'));
  put('POLICY_NO', view.get('claim.policyNumber'));
  put('LOB_CODE', lobCd);
  put('POLICY_EFF_DATE', compactDate(input.snapshot?.period?.effectiveDate));
  put('POLICY_EXP_DATE', compactDate(input.snapshot?.period?.expirationDate));

  const le = view.sub('claim.lossEvent');
  put('LOSS_DATE', compactDate(le.get('lossDate')));
  put('LOSS_TIME', compactTime(le.get('lossTime')));
  put('LOSS_TZ', le.get('lossTimeZone'));
  put('LOSS_CAUSE_CODE', causeCd);
  put('LOSS_CAUSE_DETAIL', le.get('causeDetail'));
  put('LOSS_DESC', p(le.get('description')));
  const addr = le.get('location.address') ?? {};
  put('LOSS_ADDR_LINE1', p(addr.line1));
  put('LOSS_ADDR_LINE2', p(addr.line2));
  put('LOSS_CITY', addr.city);
  put('LOSS_STATE', addr.state ?? le.get('location.state'));
  put('LOSS_ZIP', addr.postalCode);
  put('LOSS_LOC_DESC', p(le.get('location.description')));
  const geo = le.get('location.geo');
  put('LOSS_LAT', geo?.lat);
  put('LOSS_LNG', geo?.lng);
  put('INJURY_IND', yn(le.get('injuriesReported')));
  put('FATALITY_IND', yn(le.get('fatality')));
  put('VEH_INVOLVED_CNT', le.get('vehiclesInvolved'));
  put('WEATHER', le.get('weather'));
  put('CAT_CODE', le.get('catastropheCode'));
  const police = le.get('policeReport');
  put('POLICE_RPT_IND', yn(police?.filed));
  put('POLICE_AGENCY', police?.agency);
  put('POLICE_RPT_NO', police?.reportNumber);

  const parties = view.list('parties');
  put('PARTY_COUNT', parties.length || undefined);
  parties.forEach((pt, i) => {
    const n = i + 1;
    const k = (f) => `PARTY_${n}_${f}`;
    const org = pt.get('kind') === 'organization';
    put(k('TYPE'), org ? 'ORG' : 'PER');
    put(k('ROLES'), (pt.get('roles') ?? []).map((r) => ROLE_CODES.B[r] ?? r).join(','));
    put(k('ORG_NAME'), p(pt.get('organizationName')));
    put(k('FIRST_NAME'), p(pt.get('firstName')));
    put(k('LAST_NAME'), p(pt.get('lastName')));
    put(k('BIRTH_DATE'), p(compactDate(pt.get('dateOfBirth'))));
    put(k('PHONE'), p(pt.get('phone')));
    put(k('EMAIL'), p(pt.get('email')));
    const a = pt.get('address') ?? {};
    put(k('ADDR_LINE1'), p(a.line1));
    put(k('ADDR_LINE2'), p(a.line2));
    put(k('CITY'), a.city);
    put(k('STATE'), a.state);
    put(k('ZIP'), a.postalCode);
    const dl = pt.get('driversLicense');
    put(k('DL_NO'), p(dl?.number));
    put(k('DL_STATE'), dl?.state);
    put(k('CONTACT_PREF'), pt.get('preferredContact'));
    put(k('LANG'), pt.get('preferredLanguage'));
    put(k('INJURED_IND'), yn(pt.get('injured')));
    put(k('INJURY_DESC'), p(pt.get('injuryDescription')));
    put(k('POLICY_PARTY_IND'), yn(pt.get('isPolicyParty')));
    put(k('OTHER_INSURER'), pt.get('insurerName'));
    put(k('OTHER_POLICY_NO'), pt.get('otherPolicyNumber'));
  });

  const vehicles = view.list('vehicles');
  put('VEH_COUNT', vehicles.length || undefined);
  vehicles.forEach((v, i) => {
    const k = (f) => `VEH_${i + 1}_${f}`;
    put(k('ROLE'), v.get('role'));
    put(k('VIN'), v.get('vin'));
    put(k('YEAR'), v.get('year'));
    put(k('MAKE'), v.get('make'));
    put(k('MODEL'), v.get('model'));
    put(k('TRIM'), v.get('trim'));
    put(k('COLOR'), v.get('color'));
    put(k('PLATE'), p(v.get('licensePlate')));
    put(k('PLATE_STATE'), v.get('plateState'));
    put(k('POLICY_VEH_ID'), v.get('policyVehicleId'));
    put(k('DRIVABLE_IND'), yn(v.get('drivable')));
    put(k('AIRBAGS_IND'), yn(v.get('airbagsDeployed')));
    put(k('TOWED_IND'), yn(v.get('towed')));
    put(k('DAMAGE_AREAS'), (v.get('damageAreas') ?? []).join(',') || undefined);
    put(k('DAMAGE_DESC'), p(v.get('damageDescription')));
  });

  const props = view.list('properties');
  put('PROP_COUNT', props.length || undefined);
  props.forEach((pr, i) => {
    const k = (f) => `PROP_${i + 1}_${f}`;
    const a = pr.get('address') ?? {};
    put(k('ROLE'), pr.get('role'));
    put(k('ADDR_LINE1'), p(a.line1));
    put(k('ADDR_LINE2'), p(a.line2));
    put(k('CITY'), a.city);
    put(k('STATE'), a.state);
    put(k('ZIP'), a.postalCode);
    put(k('POLICY_LOC_ID'), pr.get('policyLocationId'));
    put(k('DWELLING_TYPE'), pr.get('dwellingType'));
    put(k('YEAR_BUILT'), pr.get('yearBuilt'));
    put(k('OCCUPIED_IND'), yn(pr.get('occupied')));
    put(k('HABITABLE_IND'), yn(pr.get('habitable')));
    put(k('DAMAGED_AREAS'), (pr.get('damagedAreas') ?? []).join(',') || undefined);
    put(k('DAMAGE_DESC'), p(pr.get('damageDescription')));
    put(k('MITIGATION_IND'), yn(pr.get('mitigationStarted')));
    put(k('EMERGENCY_SVC_IND'), yn(pr.get('emergencyServicesNeeded')));
  });

  put('COV_COUNT', coverages.length || undefined);
  coverages.forEach((c, i) => {
    const k = (f) => `COV_${i + 1}_${f}`;
    put(k('CODE'), c.code);
    put(k('LIMIT'), c.limit?.amount);
    put(k('LIMIT_PER_PERSON'), c.limitPerPerson?.amount);
    put(k('LIMIT_PER_OCC'), c.limitPerOccurrence?.amount);
    put(k('DEDUCTIBLE'), c.deductible?.amount);
  });

  put('X_LOB', view.get('claim.lob'));
  put('X_LOSS_TYPE', view.get('claim.lossType'));
  put('X_CHANNEL', view.get('claim.channel'));
  put('X_REPORTED_TS', compactTimestamp(view.get('claim.reportedAt')));
  put('X_RISK_STATE', view.get('claim.riskState'));
  put('X_FLAGS', (view.get('claim.flags') ?? []).join(',') || undefined);
  put('X_COVERAGE_CHECK', view.get('claim.checks.coverage'));
  if (triage) {
    put('X_TRIAGE_SEVERITY', triage.severityScore);
    put('X_TRIAGE_BAND', triage.severityBand);
    put('X_TRIAGE_COMPLEXITY', triage.complexity);
    put('X_TRIAGE_FRAUD_SCORE', triage.fraudScore);
    put('X_TRIAGE_SIU_IND', yn(triage.referToSiu));
    put('X_TRIAGE_SUBRO_IND', yn(triage.subrogation));
    put('X_TRIAGE_FASTTRACK_IND', yn(triage.fastTrackEligible));
    put('X_TRIAGE_PROVIDER', triage.provider);
    put('X_TRIAGE_MODEL', triage.model);
    put('X_TRIAGE_CONFIDENCE', triage.confidence);
  }
  put('X_ROUTE_QUEUE', view.get('claim.routing.queue'));
  put('X_ROUTE_ADJUSTER', view.get('claim.routing.adjusterId'));
  put('X_ROUTE_FASTTRACK_IND', yn(view.get('claim.routing.fastTrack')));
  view.get('claim.routing');
  view.get('claim.triage');
  view.get('claim.checks');

  return { payload: out, unmapped: unmapped(), warnings };
}
