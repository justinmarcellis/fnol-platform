import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreClaimsSuite } from '../../../../src/modules/integrations/adapters/core-claims-suite.mjs';
import { hashPayload } from '../../../../src/modules/integrations/adapters/hash.mjs';
import { autoBundle, homeBundle, mapOpts } from './fixtures.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');

/** Compare with a golden file; run with UPDATE_GOLDEN=1 to (re)write it after a reviewed change. */
function golden(name, actual) {
  const file = path.join(dir, `${name}.json`);
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(fs.readFileSync(file, 'utf8')));
}

test('profile A, auto claim: nested camelCase ACORD aggregates', () => {
  golden('auto-profile-a', coreClaimsSuite.map(autoBundle, 'A', mapOpts()));
});

test('profile B, auto claim: flat UPPER_SNAKE with YYYYMMDD', () => {
  golden('auto-profile-b', coreClaimsSuite.map(autoBundle, 'B', mapOpts()));
});

test('profile A and B, homeowners claim without triage or coverage report warnings', () => {
  const opts = { rqUid: 'evt_golden0002', now: '2026-10-18T09:00:00.000Z', config: { lobs: [] } };
  golden('home-profile-a', coreClaimsSuite.map(homeBundle, 'A', opts));
  golden('home-profile-b', coreClaimsSuite.map(homeBundle, 'B', opts));
});

test('profile B dates and times are compact', () => {
  const { payload } = coreClaimsSuite.map(autoBundle, 'B', mapOpts());
  assert.equal(payload.LOSS_DATE, '20261017');
  assert.equal(payload.LOSS_TIME, '1740');
  assert.equal(payload.POLICY_EFF_DATE, '20260301');
  assert.equal(payload.REQUEST_TS, '20261018140211');
  assert.equal(payload.PARTY_1_BIRTH_DATE, '19850402');
  assert.ok(Object.keys(payload).every((k) => k === k.toUpperCase()));
  assert.ok(Object.values(payload).every((v) => typeof v !== 'object'));
});

test('profile A keeps ISO dates and camelCase aggregates', () => {
  const { payload } = coreClaimsSuite.map(autoBundle, 'A', mapOpts());
  const rq = payload.claimsNotificationAddRq;
  assert.equal(rq.claimsOccurrence.lossDt, '2026-10-17');
  assert.equal(rq.claimsOccurrence.lossCauseCd, 'COLL');
  assert.equal(rq.policy.lobCd, 'AUTOP');
  assert.equal(rq.claimsParty.length, 2);
  assert.deepEqual(rq.claimsParty[0].claimsPartyInfo.claimsPartyRoleCd, ['Insured', 'Driver']);
});

test('unmapped lists platform fields with no target and ignores bookkeeping', () => {
  const { unmapped } = coreClaimsSuite.map(autoBundle, 'A', mapOpts());
  assert.ok(unmapped.includes('claim.documentIds'));
  assert.ok(unmapped.includes('claim.status'));
  assert.ok(!unmapped.some((p) => /tenantId|createdAt|version|provenance|Provenance/i.test(p)));
  assert.ok(!unmapped.includes('claim.lossEvent.lossDate'));
  assert.deepEqual(unmapped, [...unmapped].sort());
});

test('warnings: missing triage, coverage, snapshot, LOB code and unknown cause', () => {
  const bare = { claim: { ...homeBundle.claim, policyNumber: undefined, lob: 'pet_insurance' }, parties: [] };
  const { warnings } = coreClaimsSuite.map(bare, 'A', { rqUid: 'r', now: '2026-10-18T09:00:00.000Z', config: {}, settings: { causeCodes: {} } });
  assert.ok(warnings.some((w) => /no ACORD LOB code/.test(w)));
  assert.ok(warnings.some((w) => /no policyNumber/.test(w)));
  assert.ok(warnings.some((w) => /no coverage verification/.test(w)));
  assert.ok(warnings.some((w) => /no triage result/.test(w)));
  const odd = coreClaimsSuite.map({ claim: { ...autoBundle.claim, lossEvent: { ...autoBundle.claim.lossEvent, cause: 'meteor' } } }, 'A', mapOpts());
  assert.ok(odd.warnings.some((w) => /meteor/.test(w)));
  assert.equal(odd.payload.claimsNotificationAddRq.claimsOccurrence.lossCauseCd, 'OTHER');
});

test('tenant cause overrides win over profile tables', () => {
  const { payload } = coreClaimsSuite.map(autoBundle, 'B', mapOpts({ settings: { causeCodes: { collision: 'ZZ9' } } }));
  assert.equal(payload.LOSS_CAUSE_CODE, 'ZZ9');
});

test('maskPii replaces personal values and keeps structure', () => {
  const { payload } = coreClaimsSuite.map(autoBundle, 'A', mapOpts({ maskPii: true }));
  const text = JSON.stringify(payload);
  for (const secret of ['Ada', 'Example', 'ada@example.test', '+15555550101', 'EXAMPL123456', 'SYN-123', '1985-04-02', '100 Sample St', 'Rear-ended']) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.ok(text.includes('[pii]'));
  assert.ok(text.includes('1SYNT00000000000X'));
});

test('mapping is deterministic and does not mutate the bundle', () => {
  const before = JSON.stringify(autoBundle);
  const a = coreClaimsSuite.map(autoBundle, 'A', mapOpts());
  const b = coreClaimsSuite.map(autoBundle, 'A', mapOpts());
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(autoBundle), before);
  assert.throws(() => coreClaimsSuite.map(autoBundle, 'C', mapOpts()), /unknown mapping profile/);
});

test('payload hash is stable, key-order independent and ignores request ids and timestamps', () => {
  const a = coreClaimsSuite.map(autoBundle, 'A', mapOpts()).payload;
  const b = coreClaimsSuite.map(autoBundle, 'A', mapOpts({ rqUid: 'evt_other', now: '2027-01-01T00:00:00.000Z' })).payload;
  assert.equal(hashPayload(a), hashPayload(b));
  assert.match(hashPayload(a), /^[0-9a-f]{64}$/);
  assert.equal(hashPayload({ x: 1, y: { b: 2, a: 1 } }), hashPayload({ y: { a: 1, b: 2 }, x: 1 }));
  assert.notEqual(hashPayload({ x: 1 }), hashPayload({ x: 2 }));
  const changed = structuredClone(autoBundle);
  changed.claim.lossEvent.description = 'different';
  assert.notEqual(hashPayload(coreClaimsSuite.map(changed, 'A', mapOpts()).payload), hashPayload(a));
  const bb = coreClaimsSuite.map(autoBundle, 'B', mapOpts()).payload;
  assert.equal(hashPayload(bb), hashPayload(coreClaimsSuite.map(autoBundle, 'B', mapOpts({ rqUid: 'zzz', now: '2030-02-02T00:00:00.000Z' })).payload));
});
