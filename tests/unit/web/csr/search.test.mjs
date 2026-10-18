import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicySearch, normalizePolicyNumber } from '../../../../src/web/csr/search.js';
import { makeT } from '../../../../src/web/csr/strings.js';
import { fakeApi, FakeApiError, snapshot } from './helpers.mjs';

const t = makeT('en');
const clock = { now: () => Date.UTC(2026, 9, 18) };

test('normalizes and rejects bad policy numbers', () => {
  assert.equal(normalizePolicyNumber('  aut-100001 '), 'AUT-100001');
  assert.equal(normalizePolicyNumber('a b'), null);
  assert.equal(normalizePolicyNumber(''), null);
});

test('search calls GET /policies/{n}/snapshot with asOf and lists a selectable row', async () => {
  const api = fakeApi({ 'GET /policies/AUT-100001/snapshot': snapshot() });
  const s = createPolicySearch({ api, t, clock });
  const rows = await s.search('aut-100001');
  assert.deepEqual(api.calls[0], { method: 'GET', path: '/policies/AUT-100001/snapshot', body: { asOf: '2026-10-18' }, opts: undefined });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].period, '2026-01-01 - 2027-01-01');
  assert.equal(s.state.phase, 'done');
  assert.equal(s.select('AUT-100001').lob, 'personal_auto');
  assert.equal(s.select('NOPE'), null);
});

test('invalid input never calls the api', async () => {
  const api = fakeApi();
  const s = createPolicySearch({ api, t, clock });
  await s.search('!!');
  assert.equal(api.calls.length, 0);
  assert.equal(s.state.phase, 'invalid');
});

test('404 with envelope means no result, not unavailable', async () => {
  const api = fakeApi({ 'GET /policies/AUT-9/snapshot': () => { throw new FakeApiError(404, 'not_found', 'nope'); } });
  const s = createPolicySearch({ api, t, clock });
  await s.search('AUT-9');
  assert.equal(s.state.phase, 'done');
  assert.equal(s.state.results.length, 0);
  assert.equal(s.state.message, t('csr.search.empty'));
});

test('missing endpoint / network failure shows unavailable and retry works', async () => {
  let up = false;
  const api = fakeApi({ 'GET /policies/AUT-100001/snapshot': () => { if (!up) throw new FakeApiError(0, 'service_unavailable'); return snapshot(); } });
  const s = createPolicySearch({ api, t, clock });
  await s.search('AUT-100001');
  assert.equal(s.state.phase, 'unavailable');
  assert.equal(s.state.message, t('csr.unavailable.body'));
  up = true;
  await s.retry();
  assert.equal(s.state.phase, 'done');
  assert.equal(s.state.results.length, 1);
});
