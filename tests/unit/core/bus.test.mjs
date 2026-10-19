import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './helpers.mjs';

test('bus: outbox persisted, subscribers called async, drain awaits', async () => {
  const app = await bootApp({ isolated: true });
  const { bus } = app.ctx;
  const seen = [];
  bus.on('claim.reported', async (e) => { await new Promise((r) => setTimeout(r, 10)); seen.push(['typed', e.subject]); });
  bus.on('*', (e) => { seen.push(['star', e.type]); });
  try {
    const evt = bus.publish('alpha', 'claim.reported', 'clm_1', { lob: 'auto' });
    assert.equal(evt.specversion, '1.0');
    assert.equal(evt.tenantid, 'alpha');
    assert.equal(evt.type, 'claim.reported');
    assert.deepEqual(seen, [], 'dispatch is asynchronous');
    assert.equal(bus.outbox('alpha')[0].status, 'pending');
    await bus.drain();
    assert.deepEqual(seen.sort(), [['star', 'claim.reported'], ['typed', 'clm_1']]);
    const row = bus.outbox('alpha')[0];
    assert.equal(row.status, 'delivered');
    assert.equal(JSON.parse(row.event).data.lob, 'auto');
    assert.equal(bus.outbox('beta').length, 0);
  } finally { await app.close(); }
});

test('bus: handler errors are logged not thrown; retries recorded; failure marked', async () => {
  const app = await bootApp({ isolated: true });
  const { bus } = app.ctx;
  let calls = 0;
  bus.on('flaky', () => { calls++; if (calls < 2) throw new Error('transient'); });
  bus.on('broken', () => { throw new Error('always'); });
  try {
    bus.publish('alpha', 'flaky', 's1', {});
    bus.publish('alpha', 'broken', 's2', {});
    await bus.drain();
    const rows = Object.fromEntries(bus.outbox('alpha').map((r) => [r.type, r]));
    assert.equal(rows.flaky.status, 'delivered');
    assert.equal(rows.flaky.attempts, 2);
    assert.equal(rows.broken.status, 'failed');
    assert.equal(rows.broken.attempts, 3);
    assert.equal(rows.broken.last_error, 'always');
  } finally { await app.close(); }
});
