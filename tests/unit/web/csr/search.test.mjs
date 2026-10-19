import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPolicySearch, normalizeQuery, mapSearchResponse, summaryToRow } from '../../../../src/web/csr/search.js';
import { makeT } from '../../../../src/web/csr/strings.js';
import { fakeApi, FakeApiError } from './helpers.mjs';

const t = makeT('en');
const summary = (over = {}) => ({ policyNumber: 'AUT-100001', lob: 'personal_auto', status: 'in_force', period: { effectiveDate: '2026-01-01', expirationDate: '2027-01-01' }, namedInsureds: [{ name: 'Avery Testwell' }], vehicleCount: 1, propertyCount: 0, ...over });
const response = (items = [summary()], matchedOn = 'lastName') => ({ items, matchedOn });

test('normalizeQuery trims and rejects empty or over-long text', () => {
  assert.equal(normalizeQuery('  Testwell '), 'Testwell');
  assert.equal(normalizeQuery('   '), null);
  assert.equal(normalizeQuery(undefined), null);
  assert.equal(normalizeQuery('x'.repeat(101)), null);
});

test('mapSearchResponse maps {items, matchedOn} to rows and tolerates a bad body', () => {
  const m = mapSearchResponse(response([summary(), summary({ policyNumber: 'AUT-100002', namedInsureds: [{ name: 'A B' }, { name: 'C D' }] })], 'phone'));
  assert.equal(m.matchedOn, 'phone');
  assert.deepEqual(m.rows.map((r) => r.policyNumber), ['AUT-100001', 'AUT-100002']);
  assert.equal(m.rows[0].period, '2026-01-01 - 2027-01-01');
  assert.equal(m.rows[1].insured, 'A B, C D');
  assert.deepEqual(mapSearchResponse(null), { rows: [], matchedOn: null });
  assert.deepEqual(mapSearchResponse({ items: 'x' }).rows, []);
  assert.equal(summaryToRow({}).period, '');
});

test('search calls GET /policies with q and lists selectable rows with matchedOn', async () => {
  const api = fakeApi({ 'GET /policies': response() });
  const s = createPolicySearch({ api, t });
  const rows = await s.search('  Testwell ');
  assert.deepEqual(api.calls, [{ method: 'GET', path: '/policies', body: { q: 'Testwell' }, opts: undefined }]);
  assert.equal(rows.length, 1);
  assert.equal(s.state.phase, 'done');
  assert.equal(s.state.matchedOn, 'lastName');
  assert.equal(s.state.message, t('csr.search.found', { count: 1 }));
  assert.equal(s.select('AUT-100001').lob, 'personal_auto');
  assert.equal(s.select('NOPE'), null);
});

test('empty items shows the empty message', async () => {
  const s = createPolicySearch({ api: fakeApi({ 'GET /policies': response([], 'vin') }), t });
  await s.search('1HGCM82633A004352');
  assert.equal(s.state.phase, 'done');
  assert.equal(s.state.message, t('csr.search.empty'));
});

test('blank input never calls the api', async () => {
  const api = fakeApi();
  const s = createPolicySearch({ api, t });
  await s.search('  ');
  assert.equal(api.calls.length, 0);
  assert.equal(s.state.phase, 'invalid');
});

test('400 from the classifier is an invalid search, not unavailable', async () => {
  const api = fakeApi({ 'GET /policies': () => { throw new FakeApiError(400, 'bad_request', 'unclassifiable'); } });
  const s = createPolicySearch({ api, t });
  await s.search('?!#');
  assert.equal(s.state.phase, 'invalid');
  assert.equal(s.state.message, t('csr.search.unclassified'));
});

test('network failure shows unavailable and retry works', async () => {
  let up = false;
  const api = fakeApi({ 'GET /policies': () => { if (!up) throw new FakeApiError(0, 'service_unavailable'); return response(); } });
  const s = createPolicySearch({ api, t });
  await s.search('Testwell');
  assert.equal(s.state.phase, 'unavailable');
  up = true;
  await s.retry();
  assert.equal(s.state.phase, 'done');
  assert.equal(s.state.results.length, 1);
});

test('search.js has no exact-lookup (snapshot) call', () => {
  const src = readFileSync(new URL('../../../../src/web/csr/search.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /snapshot/i);
  assert.match(src, /api\.get\('\/policies'/);
});
