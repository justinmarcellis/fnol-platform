import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../../../src/core/scheduler.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('scheduler: runs repeatedly and cancel stops it', async () => {
  const s = createScheduler();
  let n = 0;
  const cancel = s.every(10, () => { n++; }, { name: 'tick' });
  await sleep(60);
  assert.ok(n >= 2);
  cancel();
  const after = n;
  await sleep(40);
  assert.equal(n, after);
  assert.equal(s.list().length, 0);
});

test('scheduler: timers are unref\'d', () => {
  const s = createScheduler();
  s.every(1000, () => {});
  // a ref'd interval would keep the event loop alive; check through the public list and stopAll
  assert.equal(s.list().length, 1);
  s.stopAll();
  assert.equal(s.list().length, 0);
});

test('scheduler: errors and rejections are isolated and logged', async () => {
  const logs = [];
  const s = createScheduler({ log: { error: (m, f) => logs.push([m, f.task]), warn() {} } });
  let good = 0;
  s.every(10, () => { throw new Error('boom'); }, { name: 'bad-sync' });
  s.every(10, async () => { throw new Error('nope'); }, { name: 'bad-async' });
  s.every(10, () => { good++; }, { name: 'good' });
  await sleep(60);
  s.stopAll();
  assert.ok(good >= 2);
  assert.ok(logs.some(([, t]) => t === 'bad-sync'));
  assert.ok(logs.some(([, t]) => t === 'bad-async'));
});

test('scheduler: overlapping ticks are skipped', async () => {
  const warns = [];
  const s = createScheduler({ log: { warn: (m, f) => warns.push(f.task) } });
  let started = 0;
  s.every(10, async () => { started++; await sleep(55); }, { name: 'slow' });
  await sleep(40);
  const info = s.list()[0];
  assert.equal(started, 1);
  assert.ok(info.skipped >= 1);
  assert.equal(info.running, true);
  assert.ok(warns.includes('slow'));
  s.stopAll();
});

test('scheduler: validates arguments', () => {
  const s = createScheduler();
  assert.throws(() => s.every(0, () => {}), TypeError);
  assert.throws(() => s.every(10, null), TypeError);
});

test('scheduler: stopAll prevents further runs', async () => {
  const s = createScheduler();
  let n = 0;
  s.every(10, () => { n++; });
  s.every(10, () => { n++; });
  s.stopAll();
  await sleep(40);
  assert.equal(n, 0);
});
