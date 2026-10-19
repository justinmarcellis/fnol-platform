/**
 * Local synthetic fake used by the E2E harness when tests/synthetic/index.mjs (S1-QE-02) is absent.
 * Same contract: generatePolicies, SCENARIOS, generateScenario. Deterministic, fictional data only
 * (555-01xx phones, example.test emails, no real carriers or people).
 */

export const SCENARIOS = Object.freeze({
  auto_fender_bender: { name: 'auto_fender_bender', lob: 'personal_auto', summary: 'Minor rear-end collision' },
  home_water_damage: { name: 'home_water_damage', lob: 'homeowners', summary: 'Pipe burst under sink' },
});

function hash(seed) {
  let h = 0x811c9dc5;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

/**
 * @param {{tenantId?: string, lob?: string, count?: number, seed?: number|string}} [opts]
 * @returns {Array<{policyNumber: string, lob: string, tenantId: string, insured: object, effectiveDate: string, expirationDate: string}>}
 */
export function generatePolicies({ tenantId = 'northwind', lob = 'personal_auto', count = 1, seed = 1 } = {}) {
  const n = count;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const h = hash(`${seed}:${tenantId}:${lob}:${i}`);
    out.push({
      policyNumber: `FAKE-${String(h % 900000 + 100000)}`,
      lob,
      tenantId,
      insured: { firstName: 'Avery', lastName: 'Ashgrove', phone: `(608) 555-01${String(h % 100).padStart(2, '0')}`, email: `avery${h % 1000}@example.test` },
      effectiveDate: '2026-01-01',
      expirationDate: '2027-01-01',
    });
  }
  return out;
}

/**
 * @param {string|{name: string}} nameOrOpts scenario name (key of SCENARIOS)
 * @param {{seed?: number|string, tenantId?: string}} [opts]
 */
export function generateScenario(nameOrOpts, opts = {}) {
  const o = typeof nameOrOpts === 'string' ? { ...opts, name: nameOrOpts } : { ...nameOrOpts };
  const def = SCENARIOS[o.name];
  if (!def) throw new Error(`generateScenario: unknown scenario "${o.name}". Known: ${Object.keys(SCENARIOS).join(', ')}`);
  const lob = def.lob;
  const policy = generatePolicies({ tenantId: o.tenantId, lob, seed: o.seed, count: 1 })[0];
  const party = { role: 'insured', type: 'person', firstName: 'Avery', lastName: 'Ashgrove', phone: '(608) 555-0142', email: 'avery@example.test' };
  const auto = lob === 'personal_auto';
  return {
    name: def.name,
    lob,
    lossType: auto ? 'collision' : 'water',
    policy,
    intakeAnswers: [{ questionId: 'loss_description', value: auto ? 'Rear-ended at a stop light' : 'Burst pipe in kitchen' }],
    claimCreate: {
      lob,
      lossType: auto ? 'collision' : 'water',
      tenantId: o.tenantId ?? 'northwind',
      channel: 'api',
      policyNumber: policy.policyNumber,
      riskState: 'WI',
      lossEvent: { lossDate: '2026-09-01', cause: auto ? 'collision' : 'water', description: auto ? 'Minor rear-end collision' : 'Pipe burst under sink' },
      parties: [party],
    },
    documents: [{
      kind: auto ? 'photo' : 'estimate',
      filename: auto ? 'damage.jpg' : 'estimate.pdf',
      contentType: auto ? 'image/jpeg' : 'application/pdf',
      contentBase64: Buffer.from('synthetic-fixture-bytes').toString('base64'),
    }],
    // Arrays mean "any of these is acceptable".
    expected: {
      coverageStatus: ['covered', 'partial', 'needs_review', 'policy_not_found'],
      severityBand: ['minor', 'moderate'],
      fraud: false,
      subrogation: auto,
      fastTrack: [true, false],
    },
  };
}
