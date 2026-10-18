// Synthetic policies for the mock PAS. Fictional people, fictional VINs and
// 555-01xx phone numbers. No real carriers, people or addresses.
// Exported for the platform seed script and the tests:
//   import { policies } from '../src/modules/coverage/fixtures.mjs';
//   await ctx.forTenant(tenantId).modules.coverage.seedPolicies(policies);

const usd = (amount) => ({ amount, currency: 'USD' });
const term = (effectiveDate, expirationDate, extra = {}) => ({ effectiveDate, expirationDate, ...extra });

const autoCoverages = (extra = []) => [
  { code: 'BI', description: 'Bodily injury liability', limitPerPerson: usd(100000), limitPerOccurrence: usd(300000) },
  { code: 'PD', description: 'Property damage liability', limitPerOccurrence: usd(50000) },
  ...extra,
];

export const policies = [
  {
    policyNumber: 'AUT-100001',
    lob: 'personal_auto',
    status: 'in_force',
    period: term('2026-01-01', '2027-01-01'),
    ratingState: 'IL',
    namedInsureds: [{ name: 'Avery Testwell', relation: 'primary', phone: '(555) 010-0101' }],
    drivers: [{ driverId: 'D1', name: 'Avery Testwell', excluded: false }],
    coverages: autoCoverages(),
    vehicles: [{
      unitId: 'V1', vin: '1FNOL00000A100001', year: 2021, make: 'Fabrikam', model: 'Roadster', garagingPostalCode: '60601',
      coverages: [
        { code: 'COLL', description: 'Collision', deductible: usd(500) },
        { code: 'COMP', description: 'Comprehensive', deductible: usd(250) },
        { code: 'GLASS', description: 'Full glass', deductible: usd(0) },
        { code: 'RENTAL', description: 'Rental reimbursement', limit: usd(1200) },
      ],
    }],
    endorsements: [],
  },
  {
    // Liability only: collision and comprehensive were never purchased.
    policyNumber: 'AUT-100002',
    lob: 'personal_auto',
    status: 'in_force',
    period: term('2026-02-01', '2027-02-01'),
    ratingState: 'WI',
    namedInsureds: [{ name: 'Blake Sampleton', relation: 'primary', phone: '555-010-0102' }],
    drivers: [{ driverId: 'D1', name: 'Blake Sampleton', excluded: false }],
    coverages: autoCoverages(),
    vehicles: [{ unitId: 'V1', vin: '1FNOL00000B200002', year: 2015, make: 'Contoso', model: 'Hatch', garagingPostalCode: '53202', coverages: [] }],
  },
  {
    // Expired before the typical 2026 loss date.
    policyNumber: 'AUT-100003',
    lob: 'personal_auto',
    status: 'expired',
    period: term('2025-01-01', '2026-01-01'),
    ratingState: 'IL',
    namedInsureds: [{ name: 'Casey Exampleman', relation: 'primary', phone: '555-010-0103' }],
    drivers: [],
    coverages: autoCoverages(),
    vehicles: [{ unitId: 'V1', vin: '1FNOL00000C300003', year: 2019, make: 'Fabrikam', model: 'Sedan', garagingPostalCode: '60614',
      coverages: [{ code: 'COLL', deductible: usd(1000) }, { code: 'COMP', deductible: usd(500) }] }],
  },
  {
    // Cancelled mid-term on 2026-06-15 (non-payment, synthetic).
    policyNumber: 'AUT-100004',
    lob: 'personal_auto',
    status: 'cancelled',
    period: term('2026-01-01', '2027-01-01', { cancellationDate: '2026-06-15' }),
    ratingState: 'MN',
    namedInsureds: [{ name: 'Devon Mockford', relation: 'primary', phone: '555-010-0104' }],
    drivers: [],
    coverages: autoCoverages(),
    vehicles: [{ unitId: 'V1', vin: '1FNOL00000D400004', year: 2022, make: 'Contoso', model: 'Crossover', garagingPostalCode: '55401',
      coverages: [{ code: 'COLL', deductible: usd(500) }, { code: 'COMP', deductible: usd(500) }] }],
  },
  {
    // Two vehicles; only V1 has comprehensive. Household shares a surname with AUT-100001 for search tests.
    policyNumber: 'AUT-100005',
    lob: 'personal_auto',
    status: 'in_force',
    period: term('2026-03-01', '2027-03-01'),
    ratingState: 'IL',
    namedInsureds: [
      { name: 'Emery Testwell', relation: 'primary', phone: '555-010-0105' },
      { name: 'Frankie Testwell', relation: 'spouse' },
    ],
    drivers: [{ driverId: 'D1', name: 'Emery Testwell', excluded: false }, { driverId: 'D2', name: 'Frankie Testwell', excluded: false }],
    coverages: autoCoverages(),
    vehicles: [
      { unitId: 'V1', vin: '1FNOL00000E500005', year: 2020, make: 'Fabrikam', model: 'Wagon', garagingPostalCode: '60601',
        coverages: [{ code: 'COLL', deductible: usd(750) }, { code: 'COMP', deductible: usd(250) }] },
      { unitId: 'V2', vin: '1FNOL00000E500006', year: 2018, make: 'Contoso', model: 'Pickup', garagingPostalCode: '60601',
        coverages: [{ code: 'COLL', deductible: usd(1000) }] },
    ],
  },
  {
    policyNumber: 'HOM-200001',
    lob: 'homeowners',
    status: 'in_force',
    period: term('2026-04-01', '2027-04-01'),
    ratingState: 'IL',
    namedInsureds: [{ name: 'Gray Fictionova', relation: 'primary', phone: '555-010-0201' }],
    coverages: [
      { code: 'PERSONAL_LIABILITY', limitPerOccurrence: usd(300000) },
      { code: 'MED_PAY_OTHERS', limitPerPerson: usd(5000) },
    ],
    properties: [{
      locationId: 'LOC1', dwellingType: 'single_family',
      address: { line1: '100 Placeholder Lane', city: 'Exampleton', state: 'IL', postalCode: '60601' },
      coverages: [
        // Surface water and seepage are excluded from dwelling and contents (water_weather); sudden plumbing leaks are covered.
        { code: 'DWELLING', limit: usd(350000), deductible: usd(1000), excludedPerils: ['water_weather'] },
        { code: 'OTHER_STRUCTURES', limit: usd(35000), deductible: usd(1000), excludedPerils: ['water_weather'] },
        { code: 'PERSONAL_PROPERTY', limit: usd(175000), deductible: usd(1000), excludedPerils: ['water_weather'] },
        { code: 'LOSS_OF_USE', limit: usd(70000) },
      ],
    }],
    endorsements: [],
  },
  {
    // Flood endorsement present; windstorm deductible is 2% of dwelling.
    policyNumber: 'HOM-200002',
    lob: 'homeowners',
    status: 'in_force',
    period: term('2026-05-01', '2027-05-01'),
    ratingState: 'WI',
    namedInsureds: [{ name: 'Harper Samplesmith', relation: 'primary', phone: '555-010-0202' }],
    coverages: [{ code: 'PERSONAL_LIABILITY', limitPerOccurrence: usd(500000) }],
    properties: [{
      locationId: 'LOC1', dwellingType: 'single_family',
      address: { line1: '200 Sample Street', city: 'Testville', state: 'WI', postalCode: '53202' },
      coverages: [
        { code: 'DWELLING', limit: usd(400000), deductible: usd(2), deductibleType: 'percent_of_dwelling' },
        { code: 'PERSONAL_PROPERTY', limit: usd(200000), deductible: usd(1500) },
      ],
    }],
    endorsements: [{ code: 'FLOOD', description: 'Flood coverage endorsement' }],
  },
  {
    // Contents-only policy (no dwelling coverage).
    policyNumber: 'HOM-200003',
    lob: 'homeowners',
    status: 'in_force',
    period: term('2026-06-01', '2027-06-01'),
    ratingState: 'MN',
    namedInsureds: [{ name: 'Indigo Placeholder', relation: 'primary', phone: '555-010-0203' }],
    coverages: [{ code: 'PERSONAL_LIABILITY', limitPerOccurrence: usd(100000) }],
    properties: [{
      locationId: 'LOC1', dwellingType: 'apartment',
      address: { line1: '300 Demo Court, Unit 4', city: 'Mockburg', state: 'MN', postalCode: '55401' },
      coverages: [{ code: 'PERSONAL_PROPERTY', limit: usd(40000), deductible: usd(500) }],
    }],
  },
  {
    // Cancellation scheduled for 2026-12-01; in force until then.
    policyNumber: 'AUT-100006',
    lob: 'personal_auto',
    status: 'pending_cancellation',
    period: term('2026-01-01', '2027-01-01', { cancellationDate: '2026-12-01' }),
    ratingState: 'IL',
    namedInsureds: [{ name: 'Jordan Fakeman', relation: 'primary', phone: '555-010-0106' }],
    drivers: [],
    coverages: autoCoverages(),
    vehicles: [{ unitId: 'V1', vin: '1FNOL00000F600007', year: 2023, make: 'Fabrikam', model: 'Roadster', garagingPostalCode: '60614',
      coverages: [{ code: 'COLL', deductible: usd(500) }, { code: 'COMP', deductible: usd(500) }] }],
  },
];
