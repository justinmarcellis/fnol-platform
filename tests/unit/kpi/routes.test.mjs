import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootKpiApp, get, byId } from './helpers.mjs';
import { data, alphaFixture, publishAlphaEvents } from './fakes.mjs';

let app;
before(async () => {
  app = await bootKpiApp(['alpha', 'beta']);
  data.set('alpha', alphaFixture());
  data.set('beta', { claims: [], fail: {} });
  publishAlphaEvents(app, 'alpha');
  await app.ctx.bus.drain();
});
after(async () => { data.clear(); await app.close(); });

const URL = '/api/v1/kpis?from=2026-09-01&to=2026-09-30';

test('allowed roles get the contract shape', async () => {
  for (const role of ['supervisor', 'tenant_admin', 'carrier_admin', 'auditor']) {
    const r = await get(app, URL, app.token([role]));
    assert.equal(r.status, 200, role);
    assert.deepEqual(Object.keys(r.json).sort(), ['metrics', 'period']);
    assert.equal(r.json.period.from, '2026-09-01T00:00:00.000Z');
    assert.equal(r.json.metrics.length, 11);
    for (const m of r.json.metrics) {
      for (const k of ['id', 'label', 'valueDriver', 'value', 'unit', 'numerator', 'denominator']) assert.ok(k in m, `${m.id}.${k}`);
    }
  }
});

test('other roles and anonymous callers are refused', async () => {
  for (const role of ['csr', 'adjuster', 'claimant', 'agent']) assert.equal((await get(app, URL, app.token([role]))).status, 403, role);
  assert.equal((await get(app, URL)).status, 401);
});

test('400 on bad dates and inverted ranges, with the error envelope', async () => {
  for (const q of ['from=garbage', 'to=2026-02-30', 'from=2026-09-30&to=2026-09-01', 'from=2026-09-01&from=2026-09-02']) {
    const r = await get(app, `/api/v1/kpis?${q}`, app.token(['supervisor']));
    assert.equal(r.status, 400, q);
    assert.equal(r.json.error.code, 'bad_request');
  }
});

test('no params defaults to the last 30 days', async () => {
  const r = await get(app, '/api/v1/kpis', app.token(['supervisor']));
  assert.equal(r.status, 200);
  const days = (Date.parse(r.json.period.to) - Date.parse(r.json.period.from)) / 86400000;
  assert.equal(days, 30);
});

test('tenant isolation over HTTP', async () => {
  const a = await get(app, URL, app.token(['supervisor'], 'alpha'));
  const b = await get(app, URL, app.token(['supervisor'], 'beta'));
  assert.equal(byId(a.json.metrics).stp_rate.denominator, 4);
  assert.equal(byId(b.json.metrics).stp_rate.denominator, 0);
  assert.equal(byId(b.json.metrics).stp_rate.value, null);
  // A non-platform caller cannot switch tenant with a header.
  const res = await fetch(app.url + URL, { headers: { authorization: `Bearer ${app.token(['supervisor'], 'beta')}`, 'x-tenant-id': 'alpha' } });
  assert.equal(res.status, 403);
});

test('read-only: only GET is routed', async () => {
  const res = await fetch(app.url + URL, { method: 'POST', headers: { authorization: `Bearer ${app.token(['supervisor'])}`, 'content-type': 'application/json' }, body: '{}' });
  assert.ok([404, 405].includes(res.status), String(res.status));
});

test('response has no PII or identifiers', async () => {
  const r = await get(app, URL, app.token(['auditor']));
  assert.ok(!/ses_|u9|"c\d"/.test(r.text));
  assert.ok(!r.text.includes('NaN'));
});
