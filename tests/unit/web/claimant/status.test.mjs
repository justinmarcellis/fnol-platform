import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusPoller, buildTimeline, isTerminal } from '../../../../src/web/claimant/status.js';
import { makeTranslator } from '../../../../src/web/claimant/strings.js';
import { fakeApi, fakeTimers, FakeApiError } from './helpers.mjs';

const t = makeTranslator('en');

function sequenceApi(statuses) {
  let i = 0;
  return fakeApi({ 'GET /claims/c1': () => ({ id: 'c1', status: statuses[Math.min(i++, statuses.length - 1)] }) });
}

test('polls on the interval and stops at a terminal status', async () => {
  const api = sequenceApi(['reported', 'validating', 'closed', 'closed']);
  const timers = fakeTimers();
  const p = createStatusPoller({ api, claimId: 'c1', timers });
  await p.start();
  assert.equal(p.state.status, 'reported');
  assert.equal(timers.pending[0].ms, 10000);
  await timers.fireNext();
  assert.equal(p.state.status, 'validating');
  await timers.fireNext();
  assert.equal(p.state.status, 'closed');
  assert.equal(p.state.final, true);
  assert.equal(timers.count, 0, 'no timer left after terminal');
  assert.equal(api.calls.length, 3);
});

test('pauses while hidden and refreshes when visible again', async () => {
  const api = sequenceApi(['reported', 'validating', 'triaged']);
  const timers = fakeTimers();
  const p = createStatusPoller({ api, claimId: 'c1', timers });
  await p.start();
  await p.setHidden(true);
  assert.equal(timers.count, 0);
  assert.equal(p.state.paused, true);
  assert.equal(api.calls.length, 1);
  await p.setHidden(false);
  assert.equal(api.calls.length, 2);
  assert.equal(p.state.paused, false);
  assert.equal(timers.count, 1);
});

test('a due timer while hidden does not fetch', async () => {
  const api = sequenceApi(['reported']);
  const timers = fakeTimers();
  let hidden = false;
  const p = createStatusPoller({ api, claimId: 'c1', timers, isHidden: () => hidden });
  await p.start();
  hidden = true;
  await timers.fireNext();
  assert.equal(api.calls.length, 1);
  assert.equal(p.state.paused, true);
  assert.equal(timers.count, 0);
});

test('failures mark stale, back off, and recover', async () => {
  let fail = true;
  const api = fakeApi({ 'GET /claims/c1': () => { if (fail) throw new FakeApiError(0, 'service_unavailable', 'x'); return { id: 'c1', status: 'reported' }; } });
  const timers = fakeTimers();
  const p = createStatusPoller({ api, claimId: 'c1', timers });
  await p.start();
  assert.equal(p.state.stale, true);
  assert.equal(timers.pending[0].ms, 20000);
  fail = false;
  await timers.fireNext();
  assert.equal(p.state.stale, false);
  assert.equal(timers.pending[0].ms, 10000);
});

test('stop clears the timer', async () => {
  const timers = fakeTimers();
  const p = createStatusPoller({ api: sequenceApi(['reported']), claimId: 'c1', timers });
  await p.start();
  p.stop();
  assert.equal(timers.count, 0);
});

test('timeline view-model', () => {
  const tl = buildTimeline({ status: 'assigned' }, t);
  assert.deepEqual(tl.map((i) => i.state), ['done', 'done', 'done', 'current', 'upcoming', 'upcoming']);
  const ft = buildTimeline({ status: 'fast_tracked' }, t);
  assert.equal(ft[3].id, 'fast_tracked');
  const closed = buildTimeline({ status: 'closed' }, t);
  assert.ok(closed.every((i) => i.state === 'done'));
  const wd = buildTimeline({ status: 'withdrawn' }, t);
  assert.equal(wd.length, 2);
  assert.equal(buildTimeline({ status: 'pending_info' }, t)[4].attention, true);
  assert.equal(isTerminal('withdrawn'), true);
  assert.equal(isTerminal('in_review'), false);
});

test('default timers schedule without Illegal invocation', async () => {
  // Browser setTimeout throws when called with a non-window receiver; emulate that guard.
  const real = { st: globalThis.setTimeout, ct: globalThis.clearTimeout };
  const guard = (fn) => function guarded(...a) { if (this !== globalThis && this !== undefined) throw new TypeError('Illegal invocation'); return fn.apply(globalThis, a); };
  globalThis.setTimeout = guard(real.st); globalThis.clearTimeout = guard(real.ct);
  try {
    const api = sequenceApi(['reported', 'closed']);
    const p = createStatusPoller({ api, claimId: 'c1', intervalMs: 5 });
    await p.start();
    await new Promise((r) => real.st(r, 60));
    assert.equal(p.state.status, 'closed', 'poll fired via default timers');
    p.stop();
  } finally { globalThis.setTimeout = real.st; globalThis.clearTimeout = real.ct; }
});
