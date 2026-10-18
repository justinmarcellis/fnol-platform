// Synthetic claim bundles and companion records. Fictional people, addresses and numbers only.

export const NOW = '2026-10-18T14:02:11.000Z';
export const RQ = 'evt_golden0001';

export const autoBundle = {
  claim: {
    id: 'clm_auto0000000000000001',
    tenantId: 'alpha',
    claimNumber: 'ALP-2026-000123',
    status: 'triaged',
    lob: 'personal_auto',
    lossType: 'auto_collision',
    channel: 'claimant_web',
    policyNumber: 'AUT-100001',
    riskState: 'WI',
    lossEvent: {
      lossDate: '2026-10-17',
      lossTime: '17:40',
      lossTimeZone: 'America/Chicago',
      cause: 'collision',
      description: 'Rear-ended at a stop light on Sample Street.',
      location: { description: 'Sample St at 5th Ave', address: { line1: '100 Sample St', city: 'Fictionville', state: 'WI', postalCode: '53000' }, geo: { lat: 43.1, lng: -89.4 } },
      policeReport: { filed: true, agency: 'Fictionville PD', reportNumber: 'FPD-77' },
      injuriesReported: false,
      vehiclesInvolved: 2,
      weather: 'clear',
      fieldProvenance: { description: { source: 'claimant' } },
    },
    flags: ['subrogation_candidate'],
    checks: { coverage: 'covered', coverageVerificationId: 'cvr_auto00000000000001' },
    triage: { severityScore: 32, complexity: 'low' },
    routing: { decisionId: 'rtd_auto00000000000001', queue: 'auto_fast_track', fastTrack: true },
    reportedAt: '2026-10-17T22:15:00.000Z',
    documentIds: ['doc_auto00000000000001'],
    version: 4,
    createdAt: '2026-10-17T22:15:00.000Z',
    updatedAt: '2026-10-17T22:20:00.000Z',
  },
  parties: [
    { id: 'pty_a1', tenantId: 'alpha', claimId: 'clm_auto0000000000000001', roles: ['insured', 'driver'], kind: 'person', firstName: 'Ada', lastName: 'Example', dateOfBirth: '1985-04-02', phone: '+15555550101', email: 'ada@example.test', address: { line1: '1 Test Lane', city: 'Fictionville', state: 'WI', postalCode: '53000' }, driversLicense: { number: 'EXAMPL123456', state: 'WI' }, injured: false, isPolicyParty: true, preferredContact: 'sms' },
    { id: 'pty_a2', tenantId: 'alpha', claimId: 'clm_auto0000000000000001', roles: ['claimant'], kind: 'organization', organizationName: 'Sample Delivery Co', insurerName: 'Other Mutual', otherPolicyNumber: 'OM-555' },
  ],
  vehicles: [
    { id: 'veh_a1', tenantId: 'alpha', claimId: 'clm_auto0000000000000001', role: 'insured', vin: '1SYNT00000000000X', year: 2021, make: 'Synthetic Motors', model: 'Sedan', licensePlate: 'SYN-123', plateState: 'WI', policyVehicleId: 'V1', drivable: true, airbagsDeployed: false, damageAreas: ['rear'], damageDescription: 'rear bumper' },
  ],
  properties: [],
};

export const homeBundle = {
  claim: {
    id: 'clm_home0000000000000001',
    tenantId: 'bravo',
    claimNumber: 'BRV-2026-000007',
    status: 'triaged',
    lob: 'homeowners',
    channel: 'csr_phone',
    policyNumber: 'HOM-200001',
    riskState: 'TX',
    lossEvent: { lossDate: '2026-09-30', cause: 'water_plumbing', description: 'Burst pipe in kitchen.', location: { address: { line1: '9 Demo Road', city: 'Placeholder', state: 'TX', postalCode: '75000' } } },
    reportedAt: '2026-10-01T15:00:00.000Z',
    version: 2,
    createdAt: '2026-10-01T15:00:00.000Z',
    updatedAt: '2026-10-01T15:05:00.000Z',
  },
  parties: [
    { id: 'pty_h1', tenantId: 'bravo', claimId: 'clm_home0000000000000001', roles: ['insured', 'reporter'], kind: 'person', firstName: 'Bo', lastName: 'Sample', phone: '+15555550102', dateOfBirth: '1990-12-25' },
  ],
  vehicles: [],
  properties: [
    { id: 'prp_h1', tenantId: 'bravo', claimId: 'clm_home0000000000000001', role: 'insured_location', address: { line1: '9 Demo Road', city: 'Placeholder', state: 'TX', postalCode: '75000' }, policyLocationId: 'LOC1', dwellingType: 'single_family', yearBuilt: 1998, occupied: true, habitable: false, damagedAreas: ['kitchen'], damageDescription: 'water damage to floor', mitigationStarted: true },
  ],
};

export const triage = {
  id: 'trg_1', claimId: 'clm_auto0000000000000001', severityScore: 32, severityBand: 'low', complexity: 'low',
  fraud: { score: 8, indicators: [], referToSiu: false }, subrogation: { flag: true, reasons: [] }, fastTrackEligible: true,
  explanation: 'Low severity, clear liability.', ai: { provider: 'local', model: 'local-rules-v1', confidence: 0.82 },
};

export const coverage = { id: 'cvr_1', claimId: 'clm_auto0000000000000001', policySnapshotId: 'psn_1', outcome: 'covered', status: 'in_force', matchedCoverages: ['COLL'], checks: [] };

export const snapshot = {
  id: 'psn_1', policyNumber: 'AUT-100001', lob: 'personal_auto', status: 'in_force',
  period: { effectiveDate: '2026-03-01', expirationDate: '2027-03-01' },
  coverages: [
    { code: 'BI', limitPerPerson: { amount: 100000, currency: 'USD' }, limitPerOccurrence: { amount: 300000, currency: 'USD' } },
    { code: 'COLL', deductible: { amount: 500, currency: 'USD' } },
  ],
};

/** Mapping options for the pure adapter.map in golden tests. */
export const mapOpts = (extra = {}) => ({
  coverage, snapshot, triage, rqUid: RQ, now: NOW,
  config: { lobs: [{ id: 'personal_auto', enabled: true, label: { en: 'Auto' }, acordLobCd: 'AUTOP' }] },
  ...extra,
});
