import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootKpiApp, byId } from './helpers.mjs';
import { data, alphaFixture, publishAlphaEvents } from './fakes.mjs';
import { resolvePeriod } from '../../../src/modules/kpi/service.mjs';

let app;
const P = { from: '2026-09-01', to: '2026-09-30' };

before(async () => {
  app = await bootKpiApp();
  data.set('alpha', alphaFixture());
  data.set('beta', { claims: [{ id: 'b1', channel: 'claimant_web', status: 'in_review', reportedAt: '2026-09-12T09:00:00.000Z', reportedBy: { type: 'user', role: 'claimant' }, flags: [] }], fail: {} });
  data.set('empty', { claims: [], fail: {} });
  const flaky = alphaFixture();
  flaky.fail = { triage: true };
  data.set('flaky', flaky);
  publishAlphaEvents(app, 'alpha');
  publishAlphaEvents(app, 'flaky');
  await app.ctx.bus.drain();
});
after(async () => { data.clear(); await app.close(); });

const kpis = (tenant, q = P) => app.ctx.forTenant(tenant).modules.kpi.compute(q);

test('fixture tenant: expected value, numerator and denominator for every metric', async () => {
  const { period, metrics } = await kpis('alpha');
  assert.equal(period.from, '2026-09-01T00:00:00.000Z');
  assert.equal(period.to, '2026-09-30T23:59:59.999Z');
  const m = byId(metrics);
  const expect = {
    stp_rate: [0.5, 2, 4],
    automated_capture_rate: [0.5, 2, 4],
    median_minutes_to_acknowledgment: [20, 2, 4],
    median_minutes_to_assignment: [20, 3, 4],
    coverage_verified_at_intake_rate: [0.5, 2, 4],
    fraud_flag_rate: [0.5, 2, 4],
    subrogation_flag_rate: [0.25, 1, 4],
    digital_self_service_share: [0.5, 2, 4],
    spanish_session_share: [0.5, 2, 4],
    regulatory_timers_met: [0.6667, 2, 3],
    regulatory_timers_breached: [0.3333, 1, 3],
  };
  assert.equal(metrics.length, Object.keys(expect).length);
  for (const [id, [value, numerator, denominator]] of Object.entries(expect)) {
    assert.deepEqual([m[id].value, m[id].numerator, m[id].denominator], [value, numerator, denominator], id);
    assert.equal(m[id].note, undefined, id);
  }
  assert.equal(m.stp_rate.valueDriver, 'VD-1');
  assert.equal(m.median_minutes_to_assignment.unit, 'minutes');
});

test('out-of-period claims are excluded', async () => {
  const m = byId((await kpis('alpha', { from: '2026-08-01', to: '2026-08-31' })).metrics);
  assert.equal(m.spanish_session_share.denominator, 1);
  assert.equal(m.spanish_session_share.value, 1);
  assert.equal(m.stp_rate.value, 0);
});

test('empty tenant: null values, no NaN', async () => {
  const out = await kpis('empty');
  for (const m of out.metrics) assert.equal(m.value, null, m.id);
  assert.ok(!JSON.stringify(out).includes('NaN'));
  assert.equal(byId(out.metrics).stp_rate.denominator, 0);
});

test('tenants are isolated', async () => {
  const a = byId((await kpis('alpha')).metrics);
  const b = byId((await kpis('beta')).metrics);
  assert.equal(a.stp_rate.denominator, 4);
  assert.equal(b.stp_rate.denominator, 1);
  assert.equal(b.median_minutes_to_assignment.value, null); // alpha outbox events are not visible to beta
  assert.equal(b.regulatory_timers_met.denominator, 0);
});

test('one failing source nulls only its metrics and adds a note', async () => {
  const m = byId((await kpis('flaky')).metrics);
  assert.equal(m.fraud_flag_rate.value, null);
  assert.match(m.fraud_flag_rate.note, /triage failed/);
  assert.equal(m.subrogation_flag_rate.value, null);
  assert.equal(m.stp_rate.value, 0.5);
  assert.equal(m.regulatory_timers_met.value, 0.6667);
});

test('failing claims list nulls everything without throwing', async () => {
  data.get('flaky').fail = { listClaims: true };
  const { metrics } = await kpis('flaky');
  assert.ok(metrics.every((x) => x.value === null && /claims failed/.test(x.note)));
  data.get('flaky').fail = {};
});

test('defaults to the last 30 days using the tenant clock', async () => {
  app.ctx.clock.set('2026-09-30T12:00:00.000Z');
  try {
    const { period } = await kpis('alpha', {});
    assert.equal(period.to, '2026-09-30T12:00:00.000Z');
    assert.equal(period.from, '2026-08-31T12:00:00.000Z');
  } finally { app.ctx.clock.reset(); }
});

test('output carries no PII fields or claim ids', async () => {
  const text = JSON.stringify(await kpis('alpha'));
  assert.ok(!/"c[1-5]"|ses_|u9/.test(text));
  assert.deepEqual(Object.keys(await kpis('alpha')).sort(), ['metrics', 'period']);
});

test('service is read-only: no outbox rows or audit entries added', async () => {
  const before = app.ctx.bus.outbox('alpha').length;
  const audits = app.ctx.audit.list('alpha', {}).length;
  await kpis('alpha');
  assert.equal(app.ctx.bus.outbox('alpha').length, before);
  assert.equal(app.ctx.audit.list('alpha', {}).length, audits);
});

test('resolvePeriod validation', () => {
  const now = new Date('2026-09-30T00:00:00Z');
  const E = class extends Error { constructor(code, msg, status) { super(msg); this.status = status; } };
  for (const q of [{ from: 'nope' }, { to: '2026-13-01' }, { from: '2026-02-30' }, { from: '2026-09-02', to: '2026-09-01' }, { from: ['2026-01-01', '2026-01-02'] }]) {
    assert.throws(() => resolvePeriod(q, now, E), (e) => e.status === 400, JSON.stringify(q));
  }
  assert.doesNotThrow(() => resolvePeriod({ from: '2026-09-01T00:00:00Z', to: '2026-09-01T00:00:00Z' }, now, E));
});
