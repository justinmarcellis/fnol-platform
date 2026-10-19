import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRecent, claimSummary, recentColumns } from '../../../../src/web/csr/recent.js';
import { csrStrings, makeT } from '../../../../src/web/csr/strings.js';
import { fakeApi, FakeApiError } from './helpers.mjs';

const t = makeT('en');
const dir = new URL('../../../../src/web/csr/', import.meta.url);

test('recent loads GET /claims newest first and maps rows', async () => {
  const api = fakeApi({ 'GET /claims': { items: [{ id: 'c1', claimNumber: 'NWD-2026-000001', status: 'reported', lob: 'personal_auto', policyNumber: 'AUT-100001', reportedAt: '2026-10-18T10:00:00Z', parties: [] }] } });
  const r = createRecent({ api, t });
  await r.load();
  assert.deepEqual(api.calls[0].body, { limit: 10, sort: '-reportedAt' });
  assert.equal(r.state.rows[0].claimNumber, 'NWD-2026-000001');
  assert.equal(r.state.rows[0].parties, undefined);
  assert.deepEqual(recentColumns(t).map((c) => c.key), ['claimNumber', 'status', 'lob', 'policyNumber', 'reportedAt']);
});

test('recent unavailable then retry', async () => {
  let up = false;
  const api = fakeApi({ 'GET /claims': () => { if (!up) throw new FakeApiError(503, 'service_unavailable'); return { items: [] }; } });
  const r = createRecent({ api, t });
  await r.load();
  assert.equal(r.state.phase, 'unavailable');
  up = true; await r.retry();
  assert.equal(r.state.phase, 'done');
});

test('open claim reads GET /claims/{id} and summarises read-only', async () => {
  const api = fakeApi({ 'GET /claims/c1': { id: 'c1', claimNumber: 'N-1', status: 'triaged', lob: 'homeowners', channel: 'csr_phone', triage: { severityScore: 42 } } });
  const r = createRecent({ api, t });
  await r.open('c1');
  const s = claimSummary(r.state.claim, t);
  assert.equal(s.find((x) => x.key === 'severity').value, '42');
  assert.equal(s.find((x) => x.key === 'policyNumber').value, t('csr.claim.none'));
});

test('open unknown claim (404 envelope) is failed, not unavailable', async () => {
  const api = fakeApi({ 'GET /claims/zz': () => { throw new FakeApiError(404, 'not_found'); } });
  const r = createRecent({ api, t });
  await r.open('zz');
  assert.equal(r.state.phase, 'failed');
});

test('string tables have en/es parity', () => {
  assert.deepEqual(Object.keys(csrStrings.es).sort(), Object.keys(csrStrings.en).sort());
});

test('pure modules do not import the kit; no innerHTML anywhere; page uses the shell and demo bar, no dev form', () => {
  for (const f of ['search.js', 'assisted.js', 'recent.js', 'strings.js', 'errors.js', 'answers.js', 'panel.js', 'desk.js']) {
    assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf8'), /from ['"]\/shared|import ['"]\/shared/, f);
  }
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.js') || f.endsWith('.html')) assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf8'), /innerHTML|outerHTML|insertAdjacentHTML|console\./, f);
  }
  const html = readFileSync(new URL('index.html', dir), 'utf8');
  assert.match(html, /<fx-app-shell\b/);
  assert.match(html, /<fx-demo-bar slot="demo">/);
  assert.doesNotMatch(html, /dev-form|dev-panel|id="dev-/, 'the old dev sign-in form is gone');
  assert.match(html, /fx-table id="recent-table"/);
  assert.match(html, /fx-stepper/);
  assert.match(html, /fx-toast/);
});
