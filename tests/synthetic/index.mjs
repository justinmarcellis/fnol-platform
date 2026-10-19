/**
 * Deterministic synthetic data for the FNOL platform (S1-QE-02).
 * Zero dependencies. Same seed => deep-equal output. No Math.random / Date.now.
 * All people, carriers, addresses and phone numbers are fictional (phones use 555-01xx).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createRng, addDays, addYears } from './prng.mjs';
import { person, phone, address, timeZoneFor, OTHER_CARRIERS } from './names.mjs';
import { generateVin } from './vin.mjs';
import { policeReport, repairEstimate, photoPlaceholder } from './documents.mjs';

export { isValidVin, computeCheckDigit, generateVin } from './vin.mjs';
export { createRng } from './prng.mjs';

/** Canonical LOB ids (match common.schema.json examples) and accepted aliases. */
export const LOBS = ['personal_auto', 'homeowners', 'commercial_auto'];
const LOB_ALIASES = { auto: 'personal_auto', home: 'homeowners', commercial: 'commercial_auto' };
const normalizeLob = (lob) => LOB_ALIASES[lob] || lob;

const usd = (amount) => ({ amount, currency: 'USD' });
const idOf = (prefix, rng) => `${prefix}_${rng.alnum(12, 'abcdefghjkmnpqrstuvwxyz0123456789')}`;

const VEHICLE_MODELS = [
  ['Aldera', 'Sedan LX'], ['Aldera', 'Trail 4x4'], ['Corvane', 'Hatch S'], ['Corvane', 'Cruiser'],
  ['Brightwell', 'Pickup 1500'], ['Brightwell', 'Crossover'], ['Tamsin', 'Compact']
];
const COLORS = ['Silver', 'Black', 'White', 'Blue', 'Red', 'Gray'];

/** Guarded optional read of tenants/*.json question ids; returns [] when absent. */
function tenantQuestionIds(tenantId) {
  try {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tenants');
    const file = readdirSync(dir).find((f) => f === `${tenantId}.json`);
    if (!file) return [];
    const cfg = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const ids = [];
    for (const qs of cfg.questionSets || []) for (const q of qs.questions || []) if (q.id) ids.push(q.id);
    return ids;
  } catch {
    return [];
  }
}

function autoVehicleCoverages(commercial) {
  return [
    { code: 'COLL', description: 'Collision', deductible: usd(commercial ? 1000 : 500), deductibleType: 'flat' },
    { code: 'COMP', description: 'Comprehensive', deductible: usd(commercial ? 1000 : 250), deductibleType: 'flat' },
    { code: 'GLASS', description: 'Glass', deductible: usd(0), deductibleType: 'flat' },
    { code: 'RENTAL', description: 'Rental reimbursement', limit: usd(commercial ? 1500 : 900) },
    { code: 'TOWING', description: 'Towing and labor', limit: usd(100) }
  ];
}

/** Build one policy. opts: {tenantId, lob, state, effectiveDate, status, ordinal} */
function buildPolicy(rng, o) {
  const lob = o.lob;
  const state = o.state;
  const effectiveDate = o.effectiveDate || addDays('2026-01-01', rng.int(0, 240));
  const expirationDate = addYears(effectiveDate, 1);
  const asOfDate = o.asOfDate || addDays(effectiveDate, rng.int(30, 120));
  const insured = person(rng);
  const named = [{ name: `${insured.firstName} ${insured.lastName}`, relation: 'named_insured' }];
  const policy = {
    id: idOf('pol', rng),
    tenantId: o.tenantId,
    policyNumber: `${{ personal_auto: 'PA', homeowners: 'HO', commercial_auto: 'CA' }[lob] || 'XX'}-${state}-${rng.int(1000000, 9999999)}`,
    lob,
    status: o.status || 'in_force',
    period: { effectiveDate, expirationDate },
    asOfDate,
    ratingState: state,
    namedInsureds: named,
    coverages: [],
    endorsements: [],
    sourceSystem: 'mock-pas',
    retrievedAt: `${asOfDate}T12:00:00.000Z`
  };
  if (policy.status === 'cancelled') policy.period.cancellationDate = addDays(effectiveDate, 45);

  if (lob === 'homeowners') {
    const dwelling = rng.pick([220000, 260000, 310000, 385000]);
    const addr = address(rng, state);
    policy.coverages = [
      { code: 'DWELLING', description: 'Coverage A - Dwelling', limit: usd(dwelling), deductible: usd(1000), deductibleType: 'flat' },
      { code: 'OTHER_STRUCTURES', description: 'Coverage B - Other structures', limit: usd(Math.round(dwelling * 0.1)) },
      { code: 'PERSONAL_PROPERTY', description: 'Coverage C - Personal property', limit: usd(Math.round(dwelling * 0.5)), deductible: usd(1000), deductibleType: 'flat' },
      { code: 'LOSS_OF_USE', description: 'Coverage D - Loss of use', limit: usd(Math.round(dwelling * 0.2)) },
      { code: 'PERSONAL_LIABILITY', description: 'Coverage E - Personal liability', limitPerOccurrence: usd(300000) },
      { code: 'MED_PAY_OTHERS', description: 'Coverage F - Medical payments', limitPerPerson: usd(5000) }
    ];
    policy.coverages.find((c) => c.code === 'DWELLING').excludedPerils = ['flood'];
    policy.properties = [{
      locationId: 'loc-1',
      address: addr,
      dwellingType: rng.pick(['single_family', 'townhouse', 'condo']),
      coverages: [{ code: 'DWELLING', description: 'Water damage deductible 1000', limit: usd(dwelling), deductible: usd(1000), deductibleType: 'flat' }]
    }];
    policy.endorsements = [{ code: 'HO-WTR', description: 'Water backup (sump) endorsement, 5000' }];
  } else {
    const commercial = lob === 'commercial_auto';
    const n = commercial ? rng.int(5, 10) : rng.int(1, 3);
    policy.coverages = [
      { code: 'BI', description: 'Bodily injury liability', limitPerPerson: usd(commercial ? 500000 : 100000), limitPerOccurrence: usd(commercial ? 1000000 : 300000) },
      { code: 'PD', description: 'Property damage liability', limitPerOccurrence: usd(commercial ? 1000000 : 100000), limit: usd(commercial ? 1000000 : 100000) },
      { code: 'UM', description: 'Uninsured motorist', limitPerPerson: usd(100000), limitPerOccurrence: usd(300000) },
      { code: 'MEDPAY', description: 'Medical payments', limitPerPerson: usd(5000) }
    ];
    policy.vehicles = [];
    for (let i = 0; i < n; i += 1) {
      const year = rng.int(2016, 2025);
      const [make, model] = rng.pick(VEHICLE_MODELS);
      policy.vehicles.push({
        unitId: `veh-${i + 1}`,
        vin: generateVin(rng, year),
        year,
        make,
        model,
        garagingPostalCode: address(rng, state).postalCode,
        coverages: autoVehicleCoverages(commercial)
      });
    }
    policy.drivers = [{ driverId: 'drv-1', name: named[0].name, excluded: false }];
    const second = person(rng);
    policy.drivers.push({ driverId: 'drv-2', name: `${second.firstName} ${second.lastName}`, excluded: false });
    if (commercial) {
      const biz = rng.pick(['Brightfield Freight Co (fictional)', 'Cedar Hollow Logistics (fictional)', 'Prairie Wind Delivery (fictional)']);
      policy.namedInsureds = [{ name: biz, relation: 'named_insured' }];
    }
  }
  return policy;
}

/**
 * Generate PolicySnapshot-shaped objects.
 * @param {{tenantId?:string, lob?:string, count?:number, seed?:number|string, state?:string}} [opts]
 * @returns {object[]}
 */
export function generatePolicies({ tenantId = 'northwind', lob = 'personal_auto', count = 5, seed = 1, state = 'WI' } = {}) {
  const canonical = normalizeLob(lob);
  if (!LOBS.includes(canonical)) throw new Error(`generatePolicies: unsupported lob "${lob}"`);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const rng = createRng(`policy:${tenantId}:${canonical}:${state}:${seed}:${i}`);
    out.push(buildPolicy(rng, { tenantId, lob: canonical, state }));
  }
  return out;
}

const CAUSE_TEXT = {
  rear_end: 'was stopped in traffic when another vehicle struck the rear of the insured vehicle',
  glass: 'a stone from a passing truck cracked the windshield'
};

function insuredVehicleRecord(rng, tenantId, pv, extra = {}) {
  return {
    id: idOf('veh', rng),
    tenantId,
    claimId: idOf('clm', rng),
    role: 'insured',
    vin: pv.vin,
    year: pv.year,
    make: pv.make,
    model: pv.model,
    color: rng.pick(COLORS),
    licensePlate: `${rng.alnum(3, 'ABCDEFGHJKLMNPRSTUVWXYZ')}${rng.int(1000, 9999)}`,
    policyVehicleId: pv.unitId,
    ...extra
  };
}

function party(rng, tenantId, roles, extra = {}) {
  const p = person(rng);
  return {
    id: idOf('pty', rng),
    tenantId,
    claimId: idOf('clm', rng),
    roles,
    kind: 'person',
    firstName: p.firstName,
    lastName: p.lastName,
    phone: phone(rng),
    preferredContact: 'phone',
    ...extra
  };
}

/** Scenario builders: (rng, ctx) => partial scenario. ctx = {tenantId, state, policy, lossDate, location, ...}. */
const BUILDERS = {
  auto_rear_end_injury(rng, c) {
    const pv = c.policy.vehicles[0];
    const other = party(rng, c.tenantId, ['third_party', 'driver'], { insurerName: rng.pick(OTHER_CARRIERS), otherPolicyNumber: `OP-${rng.int(100000, 999999)}` });
    const insured = party(rng, c.tenantId, ['insured', 'driver', 'claimant'], { injured: true, injuryDescription: 'Neck and shoulder pain, evaluated at urgent care', isPolicyParty: true });
    const reportNumber = `RB-${rng.int(26000000, 26999999)}`;
    const narrative = `Unit 1 (insured) ${CAUSE_TEXT.rear_end}. Unit 2 failed to stop in time and made contact at approximately 25 mph. Unit 1 driver complained of neck pain.`;
    return {
      lossType: 'collision',
      description: `I was stopped at the light on ${c.street} when the car behind me hit me hard. My neck hurts and my car has rear damage.`,
      cause: 'collision',
      injuries: true,
      police: { filed: true, reportNumber },
      parties: [insured, other],
      vehicles: [insuredVehicleRecord(rng, c.tenantId, pv, { drivable: false, damageAreas: ['rear'], damageDescription: 'Rear bumper and trunk crushed', towed: true })],
      answers: { drivable: false, injuries: true, policeReportNumber: reportNumber, otherPartyInsurer: other.insurerName },
      documents: [
        policeReport(rng, { reportNumber, lossDate: c.lossDate, lossTime: c.lossTime, location: c.locationText, narrative, injuries: true, citations: ['Following too closely (fictional ordinance 61.18) - Unit 2'], parties: [{ role: 'Insured driver', name: `${insured.firstName} ${insured.lastName}`, vehicle: `${pv.year} ${pv.make} ${pv.model}` }, { role: 'Other driver', name: `${other.firstName} ${other.lastName}`, insurer: other.insurerName }] }),
        repairEstimate(rng, { vehicle: `${pv.year} ${pv.make} ${pv.model} VIN ${pv.vin}`, claimRef: 'rear-end', lossDate: c.lossDate, parts: [{ desc: 'Rear bumper cover', price: 640 }, { desc: 'Trunk lid', price: 785 }, { desc: 'Rear impact bar', price: 410 }, { desc: 'Tail lamp assembly LH', price: 255 }], laborHours: [{ desc: 'Remove and replace rear body panels', hours: 14.5 }, { desc: 'Frame measure and straighten', hours: 6 }, { desc: 'Refinish', hours: 8.5 }] }),
        photoPlaceholder('rear-damage.png', 'Rear bumper damage')
      ],
      // ADR-003 rationale: 'major', not 'moderate': both tenants escalate any reported bodily injury (TR-INJURY-SEV, RT-INJURY-01 injury desk) and the vehicle was towed.
      expected: { coverageStatus: 'covered', severityBand: 'major', fraud: false, subrogation: true, fastTrack: false },
      meta: { deductible: 500, subrogationReason: 'rear_ended_by_other' }
    };
  },

  auto_glass_only(rng, c) {
    const pv = c.policy.vehicles[0];
    return {
      lossType: 'glass',
      description: 'A rock hit my windshield on the highway and left a crack about 8 inches long. Car is drivable.',
      cause: 'glass',
      injuries: false,
      police: { filed: false },
      parties: [party(rng, c.tenantId, ['insured', 'driver', 'reporter'], { isPolicyParty: true })],
      vehicles: [insuredVehicleRecord(rng, c.tenantId, pv, { drivable: true, damageAreas: ['glass'], damageDescription: 'Windshield crack' })],
      answers: { drivable: true, injuries: false, glassOnly: true },
      documents: [
        repairEstimate(rng, { shop: 'Cardinal Glass and Trim (fictional)', vehicle: `${pv.year} ${pv.make} ${pv.model}`, claimRef: 'glass', lossDate: c.lossDate, parts: [{ desc: 'Windshield, laminated, with sensor bracket', price: 385 }, { desc: 'Moulding kit', price: 28 }], laborHours: [{ desc: 'Replace windshield', hours: 2 }, { desc: 'Camera recalibration', hours: 1 }], laborRate: 70 }),
        photoPlaceholder('windshield.png', 'Windshield crack')
      ],
      expected: { coverageStatus: 'covered', severityBand: 'minor', fraud: false, subrogation: false, fastTrack: true },
      meta: { deductible: 0 }
    };
  },

  auto_theft_late_report(rng, c) {
    const pv = c.policy.vehicles[0];
    const reportNumber = `RB-${rng.int(26000000, 26999999)}`;
    return {
      lossType: 'theft',
      description: 'My car was parked on the street overnight and was gone in the morning. I did not think to call right away. Keys were with me.',
      cause: 'theft',
      injuries: false,
      police: { filed: true, reportNumber },
      reportDelayDays: 12,
      parties: [party(rng, c.tenantId, ['insured', 'reporter'], { isPolicyParty: true })],
      vehicles: [insuredVehicleRecord(rng, c.tenantId, pv, { drivable: false, damageAreas: ['total'], damageDescription: 'Vehicle not recovered' })],
      answers: { drivable: false, injuries: false, policeReportNumber: reportNumber, keysAvailable: true, daysToReport: 12 },
      documents: [policeReport(rng, { reportNumber, lossDate: addDays(c.lossDate, 12), lossTime: '09:40', location: c.locationText, narrative: `Complainant states the vehicle was last seen parked at the above location on ${c.lossDate}. Report taken ${12} days after the reported theft. No witnesses and no video located.`, injuries: false, citations: [], parties: [{ role: 'Complainant (owner)', name: 'On file', vehicle: `${pv.year} ${pv.make} ${pv.model} VIN ${pv.vin}` }] })],
      expected: { coverageStatus: 'covered', severityBand: 'major', fraud: true, subrogation: false, fastTrack: false },
      meta: { fraudIndicators: ['late_report', 'no_witnesses'], reportDelayDays: 12 }
    };
  },

  auto_hit_and_run(rng, c) {
    const pv = c.policy.vehicles[0];
    const reportNumber = `RB-${rng.int(26000000, 26999999)}`;
    return {
      lossType: 'hit_and_run',
      description: 'Came back to my parked car in a lot and found the driver side crushed. Someone left without a note.',
      cause: 'hit_and_run',
      injuries: false,
      police: { filed: true, reportNumber },
      parties: [party(rng, c.tenantId, ['insured', 'reporter'], { isPolicyParty: true })],
      vehicles: [insuredVehicleRecord(rng, c.tenantId, pv, { drivable: true, damageAreas: ['left'], damageDescription: 'Driver side doors dented and scraped, paint transfer' })],
      answers: { drivable: true, injuries: false, policeReportNumber: reportNumber, otherPartyKnown: false },
      documents: [
        policeReport(rng, { reportNumber, lossDate: c.lossDate, lossTime: c.lossTime, location: c.locationText, narrative: 'Complainant returned to parked vehicle and found damage to the left side with white paint transfer. Offending vehicle left the scene. No witnesses located; lot camera requested.', injuries: false, citations: ['Leaving the scene of a property damage accident - unknown driver'], parties: [{ role: 'Complainant (owner)', name: 'On file', vehicle: `${pv.year} ${pv.make} ${pv.model}` }, { role: 'Unknown driver', name: 'Unknown' }] }),
        repairEstimate(rng, { vehicle: `${pv.year} ${pv.make} ${pv.model}`, claimRef: 'hit-and-run', lossDate: c.lossDate, parts: [{ desc: 'Front door shell LH', price: 520 }, { desc: 'Rear door skin LH', price: 330 }], laborHours: [{ desc: 'Replace door panels', hours: 7 }, { desc: 'Refinish and blend', hours: 6.5 }] }),
        photoPlaceholder('left-side.png', 'Driver side damage')
      ],
      expected: { coverageStatus: 'covered', severityBand: 'moderate', fraud: false, subrogation: false, fastTrack: false },
      meta: { deductible: 500 }
    };
  },

  home_water_small(rng, c) {
    const prop = c.policy.properties[0];
    const estimate = repairEstimate(rng, { vehicle: 'N/A - dwelling repair: kitchen supply line leak', claimRef: 'water-small', lossDate: c.lossDate, shop: 'Hearthstone Restoration (fictional)', parts: [{ desc: 'Water-resistant drywall 4x8 (3 sheets)', price: 54 }, { desc: 'Flooring underlayment', price: 96 }, { desc: 'Supply line and fittings', price: 38 }], laborHours: [{ desc: 'Dry-out and drywall replacement', hours: 8 }, { desc: 'Plumbing repair', hours: 2 }, { desc: 'Paint', hours: 4 }] });
    return {
      lossType: 'water_plumbing',
      description: 'The supply line under the kitchen sink burst while we were out. I shut off the valve and wiped up. Cabinet floor and a bit of drywall are wet.',
      cause: 'water_plumbing',
      injuries: false,
      police: { filed: false },
      parties: [party(rng, c.tenantId, ['insured', 'reporter'], { isPolicyParty: true })],
      properties: [{ id: idOf('prp', rng), tenantId: c.tenantId, claimId: idOf('clm', rng), role: 'insured_location', address: prop.address, policyLocationId: prop.locationId, dwellingType: prop.dwellingType, occupied: true, habitable: true, damagedAreas: ['kitchen'], damageDescription: 'Cabinet base and lower drywall wet', mitigationStarted: true, emergencyServicesNeeded: false }],
      answers: { injuries: false, habitable: true, mitigationStarted: true, waterSource: 'supply_line' },
      documents: [estimate, photoPlaceholder('kitchen.png', 'Kitchen water damage')],
      expected: { coverageStatus: 'covered', severityBand: 'minor', fraud: false, subrogation: false, fastTrack: true },
      meta: { estimateTotal: estimate.metadata.total, deductible: 1000 }
    };
  },

  home_fire_large(rng, c) {
    const prop = c.policy.properties[0];
    const reportNumber = `FD-${rng.int(26000, 26999)}`;
    return {
      lossType: 'fire',
      description: 'Kitchen fire spread to the attic. The fire department put it out but the house is not livable. Smoke and water damage throughout.',
      cause: 'fire',
      injuries: false,
      police: { filed: true, agency: 'Fire Department (fictional)', reportNumber },
      parties: [party(rng, c.tenantId, ['insured', 'reporter'], { isPolicyParty: true })],
      properties: [{ id: idOf('prp', rng), tenantId: c.tenantId, claimId: idOf('clm', rng), role: 'insured_location', address: prop.address, policyLocationId: prop.locationId, dwellingType: prop.dwellingType, occupied: false, habitable: false, damagedAreas: ['kitchen', 'roof', 'interior', 'contents'], damageDescription: 'Structure fire, attic and roof heavily damaged', mitigationStarted: false, emergencyServicesNeeded: true }],
      answers: { injuries: false, habitable: false, fireDepartmentReport: reportNumber, needsTemporaryHousing: true },
      documents: [
        policeReport(rng, { agency: 'Maple County Fire Department (fictional)', reportNumber, lossDate: c.lossDate, lossTime: c.lossTime, location: c.locationText, narrative: 'Crews arrived to heavy smoke from the kitchen with fire extension to the attic. Fire knocked down in 35 minutes. Origin: kitchen range area. Cause undetermined pending inspection. Structure unsafe for occupancy.', injuries: false, citations: [], parties: [{ role: 'Property owner', name: 'On file' }] }),
        photoPlaceholder('fire-exterior.png', 'Exterior fire damage')
      ],
      expected: { coverageStatus: 'covered', severityBand: 'severe', fraud: false, subrogation: false, fastTrack: false },
      meta: { totalLossLikely: true, deductible: 1000 }
    };
  },

  home_loss_before_inception(rng, c) {
    const prop = c.policy.properties[0];
    return {
      lossType: 'wind',
      description: 'A storm took shingles off the roof and there is a leak in the bedroom ceiling. This happened before I finalized the new policy.',
      cause: 'wind',
      injuries: false,
      police: { filed: false },
      parties: [party(rng, c.tenantId, ['insured', 'reporter'], { isPolicyParty: true })],
      properties: [{ id: idOf('prp', rng), tenantId: c.tenantId, claimId: idOf('clm', rng), role: 'insured_location', address: prop.address, policyLocationId: prop.locationId, dwellingType: prop.dwellingType, occupied: true, habitable: true, damagedAreas: ['roof', 'interior'], damageDescription: 'Missing shingles, ceiling stain', mitigationStarted: false, emergencyServicesNeeded: false }],
      answers: { injuries: false, habitable: true, lossBeforePolicyStart: true },
      documents: [photoPlaceholder('roof.png', 'Roof shingle loss')],
      expected: { coverageStatus: 'not_covered', severityBand: 'moderate', fraud: false, subrogation: false, fastTrack: false },
      meta: { failedChecks: ['loss_in_period'], note: 'Loss date precedes policy effective date; CoverageVerification outcome not_covered.' }
    };
  },

  commercial_auto_fleet_collision(rng, c) {
    const pv = c.policy.vehicles[rng.int(0, c.policy.vehicles.length - 1)];
    const other = party(rng, c.tenantId, ['third_party', 'driver'], { injured: false, insurerName: rng.pick(OTHER_CARRIERS) });
    const driver = party(rng, c.tenantId, ['driver', 'reporter'], { isPolicyParty: true });
    const reportNumber = `RB-${rng.int(26000000, 26999999)}`;
    return {
      lossType: 'collision',
      description: 'Our delivery van was hit while changing lanes on a county highway. Other driver ran into the passenger side. Van is towed.',
      cause: 'collision',
      injuries: false,
      police: { filed: true, reportNumber },
      parties: [driver, other],
      vehicles: [insuredVehicleRecord(rng, c.tenantId, pv, { drivable: false, towed: true, damageAreas: ['right', 'front'], damageDescription: 'Right side and front fender crushed' })],
      answers: { drivable: false, injuries: false, policeReportNumber: reportNumber, fleetUnitId: pv.unitId, businessUse: true },
      documents: [
        policeReport(rng, { reportNumber, lossDate: c.lossDate, lossTime: c.lossTime, location: c.locationText, narrative: 'Unit 1 (commercial van) was lawfully changing lanes. Unit 2 moved into the same lane from the right and contacted the passenger side. Fault assessed to Unit 2 for improper lane usage.', injuries: false, citations: ['Improper lane usage (fictional ordinance 61.34) - Unit 2'], parties: [{ role: 'Insured fleet driver', name: `${driver.firstName} ${driver.lastName}`, vehicle: `${pv.year} ${pv.make} ${pv.model}` }, { role: 'Other driver', name: `${other.firstName} ${other.lastName}`, insurer: other.insurerName }] }),
        repairEstimate(rng, { vehicle: `${pv.year} ${pv.make} ${pv.model} VIN ${pv.vin}`, claimRef: 'fleet', lossDate: c.lossDate, parts: [{ desc: 'Right front fender', price: 610 }, { desc: 'Sliding door assembly', price: 1850 }, { desc: 'Right headlamp', price: 475 }, { desc: 'Door glass', price: 290 }], laborHours: [{ desc: 'Body repair and panel replacement', hours: 22 }, { desc: 'Refinish', hours: 12 }, { desc: 'Mechanical alignment', hours: 3 }], laborRate: 68 }),
        photoPlaceholder('van-right-side.png', 'Fleet van damage')
      ],
      expected: { coverageStatus: 'covered', severityBand: 'major', fraud: false, subrogation: true, fastTrack: false },
      meta: { deductible: 1000, fleetSize: c.policy.vehicles.length }
    };
  }
};

/** Static scenario catalogue (name, lob, summary). */
export const SCENARIOS = Object.freeze({
  auto_rear_end_injury: Object.freeze({ name: 'auto_rear_end_injury', lob: 'personal_auto', summary: 'Rear-ended while stopped, injury, third party at fault (subrogation)' }),
  auto_glass_only: Object.freeze({ name: 'auto_glass_only', lob: 'personal_auto', summary: 'Windshield crack, fast track' }),
  auto_theft_late_report: Object.freeze({ name: 'auto_theft_late_report', lob: 'personal_auto', summary: 'Theft reported to police 12 days late, fraud indicators' }),
  auto_hit_and_run: Object.freeze({ name: 'auto_hit_and_run', lob: 'personal_auto', summary: 'Parked car struck, unknown driver' }),
  home_water_small: Object.freeze({ name: 'home_water_small', lob: 'homeowners', summary: 'Supply line leak under 2500 estimate, fast track' }),
  home_fire_large: Object.freeze({ name: 'home_fire_large', lob: 'homeowners', summary: 'Kitchen fire, uninhabitable, likely total loss' }),
  home_loss_before_inception: Object.freeze({ name: 'home_loss_before_inception', lob: 'homeowners', summary: 'Loss date before policy effective date' }),
  commercial_auto_fleet_collision: Object.freeze({ name: 'commercial_auto_fleet_collision', lob: 'commercial_auto', summary: 'Fleet van hit by third party, subrogation' })
});

const SCENARIO_NAMES = Object.keys(SCENARIOS);

/**
 * Generate a full scenario deterministically.
 * @param {string|{name:string,seed?:*,tenantId?:string,state?:string}} nameOrOpts scenario name (or options with name)
 * @param {{seed?:number|string, tenantId?:string, state?:string}} [opts]
 * @returns {{name:string,lob:string,lossType:string,intakeAnswers:object,claimCreate:object,documents:object[],expected:object,policy:object,meta:object}}
 */
export function generateScenario(nameOrOpts, opts = {}) {
  const o = typeof nameOrOpts === 'string' ? { ...opts, name: nameOrOpts } : { ...nameOrOpts };
  const { name, seed = 1, tenantId = 'northwind', state = 'WI' } = o;
  const spec = SCENARIOS[name];
  if (!spec) throw new Error(`generateScenario: unknown scenario "${name}". Known: ${SCENARIO_NAMES.join(', ')}`);
  const rng = createRng(`scenario:${name}:${tenantId}:${state}:${seed}`);

  // Policy: for pre-inception scenario, the loss precedes a mid-year effective date.
  const effectiveDate = name === 'home_loss_before_inception' ? addDays('2026-06-01', rng.int(0, 60)) : addDays('2026-01-01', rng.int(0, 90));
  const policy = buildPolicy(rng.fork('policy'), { tenantId, lob: spec.lob, state, effectiveDate, asOfDate: addDays(effectiveDate, 60) });
  const lossDate = name === 'home_loss_before_inception' ? addDays(effectiveDate, -rng.int(5, 20)) : addDays(effectiveDate, rng.int(45, 150));
  const lossTime = `${String(rng.int(0, 23)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}`;
  const addr = (policy.properties && policy.properties[0].address) || address(rng, state);
  const street = `${addr.line1}`;
  const locationText = `${addr.line1}, ${addr.city}, ${addr.state} ${addr.postalCode}`;

  const b = BUILDERS[name](rng.fork('body'), { tenantId, state, policy, lossDate, lossTime, street, locationText });

  const reportedDate = b.reportDelayDays ? addDays(lossDate, b.reportDelayDays) : lossDate;
  const intakeAnswers = {
    lossDate,
    lossTime,
    lossDescription: b.description,
    lossType: b.lossType,
    policyNumber: policy.policyNumber,
    injuries: b.injuries,
    ...b.answers
  };
  // Key by tenant question ids when a tenant config declares them (generic keys remain).
  for (const qid of tenantQuestionIds(tenantId)) {
    if (!(qid in intakeAnswers)) {
      const k = qid.replace(/^q[_-]?/, '');
      if (k in intakeAnswers) intakeAnswers[qid] = intakeAnswers[k];
    }
  }

  const claimCreate = {
    tenantId,
    lob: spec.lob,
    lossType: b.lossType,
    channel: 'api',
    policyNumber: policy.policyNumber,
    riskState: state,
    lossEvent: {
      lossDate,
      lossTime,
      lossTimeZone: timeZoneFor(state),
      cause: b.cause,
      description: b.description,
      location: { description: locationText, address: addr, state },
      policeReport: b.police.filed ? { filed: true, agency: b.police.agency || 'Riverbend Police Department (fictional)', reportNumber: b.police.reportNumber } : { filed: false },
      injuriesReported: b.injuries,
      fatality: false
    },
    parties: b.parties,
    externalRef: { system: 'synthetic', id: `${name}-${seed}` }
  };
  if (b.vehicles) {
    claimCreate.vehicles = b.vehicles;
    claimCreate.lossEvent.vehiclesInvolved = b.vehicles.length + (b.parties.some((p) => p.roles.includes('third_party')) ? 1 : 0);
  }
  if (b.properties) claimCreate.properties = b.properties;

  return {
    name,
    lob: spec.lob,
    lossType: b.lossType,
    intakeAnswers,
    claimCreate,
    documents: b.documents,
    expected: b.expected,
    policy,
    meta: { ...b.meta, seed, reportedDate, lossDate }
  };
}
