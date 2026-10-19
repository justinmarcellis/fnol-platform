import { ROLE_CODES } from '../codes.mjs';
import { createTracker } from '../tracker.mjs';
import { clean, piiOf, resolveCommon, triageFacts } from './shared.mjs';

const money = (m) => (m ? { amt: m.amount, curCd: m.currency } : undefined);

function address(a, p) {
  if (!a) return undefined;
  return clean({ addr1: p(a.line1), addr2: p(a.line2), city: a.city, stateProvCd: a.state, postalCode: a.postalCode, countryCd: a.country });
}

/**
 * Profile A (Aurelia-style): nested camelCase ACORD aggregates, ISO dates.
 * @param {object} input see adapter.map
 * @returns {{ payload: object, unmapped: string[], warnings: string[] }}
 */
export function mapProfileA(input) {
  const warnings = [];
  const { view, unmapped } = createTracker(input.bundle);
  const p = piiOf(input.maskPii);
  const { lobCd, causeCd, coverages } = resolveCommon(input, 'A', warnings, { lob: view.get('claim.lob'), cause: view.get('claim.lossEvent.cause'), policyNumber: view.get('claim.policyNumber') });
  const triage = triageFacts(input, warnings);

  const le = view.sub('claim.lossEvent');
  const geo = le.get('location.geo');
  const police = le.get('policeReport');
  const occurrence = clean({
    itemIdInfo: { agencyId: view.get('claim.claimNumber') },
    lossDt: le.get('lossDate'),
    lossTime: le.get('lossTime'),
    lossTimeZone: le.get('lossTimeZone'),
    lossCauseCd: causeCd,
    causeDetailDesc: le.get('causeDetail'),
    incidentDesc: p(le.get('description')),
    addr: clean({
      ...address(le.get('location.address'), p),
      locationDesc: p(le.get('location.description')),
      stateProvCd: le.get('location.address')?.state ?? le.get('location.state'),
      geoPoint: geo ? { latitude: geo.lat, longitude: geo.lng } : undefined,
    }),
    injuryInd: le.get('injuriesReported'),
    fatalityInd: le.get('fatality'),
    vehiclesInvolvedCnt: le.get('vehiclesInvolved'),
    weatherDesc: le.get('weather'),
    catastropheCd: le.get('catastropheCode'),
    policeReport: police ? clean({ filedInd: police.filed, agencyName: police.agency, reportNumber: police.reportNumber }) : undefined,
  });

  const claimsParty = view.list('parties').map((pt) => {
    const kind = pt.get('kind');
    const roles = (pt.get('roles') ?? []).map((r) => ROLE_CODES.A[r] ?? r);
    const name = kind === 'organization'
      ? { commlName: { commercialName: p(pt.get('organizationName')) } }
      : { personName: clean({ givenName: p(pt.get('firstName')), surname: p(pt.get('lastName')) }) };
    const dl = pt.get('driversLicense');
    return clean({
      claimsPartyInfo: clean({ claimsPartyRoleCd: roles, injuredInd: pt.get('injured'), injuryDesc: p(pt.get('injuryDescription')), policyPartyInd: pt.get('isPolicyParty') }),
      generalPartyInfo: clean({
        nameInfo: { ...name, legalEntityCd: kind === 'organization' ? 'CO' : 'IN' },
        addr: address(pt.get('address'), p),
        birthDt: p(pt.get('dateOfBirth')),
        communicationsInfo: clean({ phoneNumber: p(pt.get('phone')), emailAddr: p(pt.get('email')), preferredContactCd: pt.get('preferredContact'), preferredLanguageCd: pt.get('preferredLanguage') }),
        driversLicense: dl ? clean({ licenseNumber: p(dl.number), stateProvCd: dl.state }) : undefined,
      }),
      otherInsurance: pt.get('insurerName') || pt.get('otherPolicyNumber') ? clean({ insurerName: pt.get('insurerName'), policyNumber: pt.get('otherPolicyNumber') }) : undefined,
    });
  });

  const autoLossInfo = view.list('vehicles').map((v) => clean({
    roleCd: v.get('role'),
    vehInfo: clean({
      vehIdentificationNumber: v.get('vin'), modelYear: v.get('year'), manufacturer: v.get('make'), model: v.get('model'),
      trim: v.get('trim'), colorDesc: v.get('color'), licensePlateNumber: p(v.get('licensePlate')), licensePlateStateProvCd: v.get('plateState'),
      policyVehicleId: v.get('policyVehicleId'),
    }),
    drivableInd: v.get('drivable'),
    airbagsDeployedInd: v.get('airbagsDeployed'),
    towedInd: v.get('towed'),
    damageAreaCd: v.get('damageAreas'),
    damageDesc: p(v.get('damageDescription')),
    currentLocation: address(v.get('currentLocation')?.address, p),
  }));

  const propertyLossInfo = view.list('properties').map((pr) => clean({
    roleCd: pr.get('role'),
    location: clean({ ...address(pr.get('address'), p), policyLocationId: pr.get('policyLocationId') }),
    dwellingTypeCd: pr.get('dwellingType'),
    yearBuilt: pr.get('yearBuilt'),
    occupiedInd: pr.get('occupied'),
    habitableInd: pr.get('habitable'),
    damagedAreaCd: pr.get('damagedAreas'),
    damageDesc: p(pr.get('damageDescription')),
    mitigationStartedInd: pr.get('mitigationStarted'),
    emergencyServicesInd: pr.get('emergencyServicesNeeded'),
  }));

  const rq = clean({
    rqUID: input.rqUid,
    transactionRequestDt: input.now,
    policy: clean({
      policyNumber: view.get('claim.policyNumber'),
      lobCd,
      contractTerm: input.snapshot?.period ? clean({ effectiveDt: input.snapshot.period.effectiveDate, expirationDt: input.snapshot.period.expirationDate }) : undefined,
      coverage: coverages.length
        ? coverages.map((c) => clean({ coverageCd: c.code, limit: money(c.limit), limitPerPerson: money(c.limitPerPerson), limitPerOccurrence: money(c.limitPerOccurrence), deductible: money(c.deductible) }))
        : undefined,
    }),
    claimsOccurrence: occurrence,
    claimsParty,
    autoLossInfo: autoLossInfo.length ? autoLossInfo : undefined,
    propertyLossInfo: propertyLossInfo.length ? propertyLossInfo : undefined,
    'com.fnolplatform_Claim': clean({
      lob: view.get('claim.lob'),
      lossType: view.get('claim.lossType'),
      channel: view.get('claim.channel'),
      reportedDt: view.get('claim.reportedAt'),
      riskStateCd: view.get('claim.riskState'),
      flags: view.get('claim.flags'),
      coverageCheck: view.get('claim.checks.coverage'),
    }),
    'com.fnolplatform_Triage': triage ? clean({
      severityScore: triage.severityScore, severityBand: triage.severityBand, complexity: triage.complexity, fraudScore: triage.fraudScore,
      referToSiuInd: triage.referToSiu, subrogationInd: triage.subrogation, fastTrackEligibleInd: triage.fastTrackEligible,
      provider: triage.provider, model: triage.model, confidence: triage.confidence,
    }) : undefined,
    'com.fnolplatform_Routing': clean({ queue: view.get('claim.routing.queue'), adjusterId: view.get('claim.routing.adjusterId'), fastTrackInd: view.get('claim.routing.fastTrack') }),
  });
  // Summary fields read from the embedded claim.triage / checks are covered by the triage result.
  view.get('claim.triage');
  view.get('claim.checks');
  view.get('claim.routing');
  return { payload: { claimsNotificationAddRq: rq }, unmapped: unmapped(), warnings };
}
