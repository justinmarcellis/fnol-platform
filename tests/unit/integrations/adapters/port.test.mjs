import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, assertClaimsPortAdapter } from '../../../../src/modules/integrations/adapters/port.mjs';
import { coreClaimsSuite } from '../../../../src/modules/integrations/adapters/core-claims-suite.mjs';

test('registry registers, gets and lists adapters', () => {
  const r = createRegistry([coreClaimsSuite]);
  assert.equal(r.get('core-claims-suite'), coreClaimsSuite);
  assert.equal(r.get('nope'), null);
  assert.deepEqual(r.list().map((a) => a.id), ['core-claims-suite']);
});

test('registry rejects duplicates and malformed adapters', () => {
  const r = createRegistry([coreClaimsSuite]);
  assert.throws(() => r.register(coreClaimsSuite), /already registered/);
  assert.throws(() => assertClaimsPortAdapter({ id: 'Bad Id', format: 'x', map() {}, send() {} }), /id/);
  assert.throws(() => assertClaimsPortAdapter({ id: 'ok-id', format: 'x', send() {} }), /map/);
  assert.throws(() => assertClaimsPortAdapter({ id: 'ok-id', format: 'x', map() {} }), /send/);
  assert.throws(() => assertClaimsPortAdapter(null), /not an object/);
});

test('core-claims-suite satisfies the port interface', () => {
  assert.equal(coreClaimsSuite.id, 'core-claims-suite');
  assert.equal(coreClaimsSuite.port, 'claims');
  assert.equal(coreClaimsSuite.format, 'acord-aligned-json');
  assert.deepEqual(coreClaimsSuite.profiles, ['A', 'B']);
});

test('send rejects an unknown target and surfaces HTTP failures', async () => {
  await assert.rejects(() => coreClaimsSuite.send({}, { kind: 'carrier-pigeon' }), /unknown send target/);
  const fetch500 = async () => ({ status: 500, json: async () => ({}) });
  await assert.rejects(() => coreClaimsSuite.send({}, { kind: 'http', url: 'http://x.test', fetch: fetch500 }), /responded 500/);
  const fetchNoNumber = async () => ({ status: 200, json: async () => ({}) });
  await assert.rejects(() => coreClaimsSuite.send({}, { kind: 'http', url: 'http://x.test', fetch: fetchNoNumber }), /no coreClaimNumber/);
  const ok = async () => ({ status: 201, json: async () => ({ coreClaimNumber: 'C-1' }) });
  assert.deepEqual((await coreClaimsSuite.send({}, { kind: 'http', url: 'http://x.test', fetch: ok })).externalId, 'C-1');
});
