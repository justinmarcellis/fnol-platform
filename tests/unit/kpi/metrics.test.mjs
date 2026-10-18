import test from 'node:test';
import assert from 'node:assert/strict';
import { median, ratio, computeMetrics, METRIC_DEFS } from '../../../src/modules/kpi/metrics.mjs';

const ids = ['stp_rate', 'automated_capture_rate', 'median_minutes_to_acknowledgment', 'median_minutes_to_assignment',
  'coverage_verified_at_intake_rate', 'fraud_flag_rate', 'subrogation_flag_rate', 'digital_self_service_share',
  'spanish_session_share', 'regulatory_timers_met', 'regulatory_timers_breached'];

test('median handles empty, odd, even and non-finite input', () => {
  assert.equal(median([]), null);
  assert.equal(median([NaN, undefined]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 10]), 2.5);
});

test('ratio returns null for zero or invalid denominators, never NaN', () => {
  assert.equal(ratio(0, 0), null);
  assert.equal(ratio(1, 0), null);
  assert.equal(ratio(NaN, 3), null);
  assert.equal(ratio(1, 3), 0.3333);
  assert.equal(ratio(0, 5), 0);
});

test('every required metric is defined with a value driver and definition', () => {
  assert.deepEqual(METRIC_DEFS.map((d) => d.id), ids);
  for (const d of METRIC_DEFS) { assert.match(d.valueDriver, /^VD-\d$/); assert.ok(d.definition.length > 20); }
});

test('empty input yields null values with zero denominators', () => {
  const out = computeMetrics([], {});
  assert.equal(out.length, ids.length);
  for (const m of out) assert.equal(m.value, null, m.id);
  assert.ok(!JSON.stringify(out).includes('NaN'));
});

test('computes rates and medians over records', () => {
  const rec = (o) => ({ reportedAt: '2026-09-10T10:00:00Z', channel: 'claimant_web', actorRole: 'claimant', timers: [], manualTaskCount: 0, ...o });
  const out = Object.fromEntries(computeMetrics([
    rec({ fastTrack: true, ackAt: '2026-09-10T10:30:00Z', locale: 'es-US', timers: [{ status: 'met' }] }),
    rec({ fastTrack: true, manualTaskCount: 1, ackAt: '2026-09-10T10:10:00Z', timers: [{ status: 'breached' }, { status: 'running' }] }),
    rec({ channel: 'csr_phone', actorRole: 'csr', ackAt: '2026-09-09T10:00:00Z' }),
  ], {}).map((m) => [m.id, m]));
  assert.deepEqual([out.stp_rate.numerator, out.stp_rate.denominator, out.stp_rate.value], [1, 3, 0.3333]);
  assert.equal(out.median_minutes_to_acknowledgment.value, 20);
  assert.equal(out.median_minutes_to_acknowledgment.numerator, 2); // negative duration ignored
  assert.equal(out.digital_self_service_share.value, 0.6667);
  assert.equal(out.spanish_session_share.numerator, 1);
  assert.deepEqual([out.regulatory_timers_met.numerator, out.regulatory_timers_met.denominator], [1, 2]);
  assert.equal(out.regulatory_timers_breached.value, 0.5);
});

test('coverage at intake respects the window', () => {
  const r = (v) => ({ reportedAt: '2026-09-10T10:00:00Z', verifiedAt: v });
  const m = computeMetrics([r('2026-09-10T10:15:00Z'), r('2026-09-10T10:16:00Z'), r(undefined)], {})
    .find((x) => x.id === 'coverage_verified_at_intake_rate');
  assert.equal(m.numerator, 1);
  assert.equal(m.denominator, 3);
});

test('unavailable or failed source nulls only dependent metrics, with a note', () => {
  const out = Object.fromEntries(computeMetrics([{ reportedAt: '2026-09-10T10:00:00Z', channel: 'claimant_web' }], { triage: 'failed', routing: 'unavailable' })
    .map((m) => [m.id, m]));
  assert.equal(out.fraud_flag_rate.value, null);
  assert.match(out.fraud_flag_rate.note, /triage failed/);
  assert.equal(out.fraud_flag_rate.numerator, null);
  assert.match(out.stp_rate.note, /routing unavailable/);
  assert.equal(out.digital_self_service_share.value, 1);
  assert.equal(out.digital_self_service_share.note, undefined);
});

test('a throwing records getter isolates to one metric note', () => {
  const bad = { get timers() { throw new Error('x'); }, channel: 'claimant_web' };
  const out = Object.fromEntries(computeMetrics([bad], {}).map((m) => [m.id, m]));
  assert.equal(out.regulatory_timers_met.value, null);
  assert.equal(out.regulatory_timers_met.note, 'computation failed');
  assert.equal(out.digital_self_service_share.value, 1);
});
