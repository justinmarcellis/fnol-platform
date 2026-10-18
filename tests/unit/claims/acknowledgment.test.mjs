// REQ-12 instant acknowledgment: claim.reported -> audit entry, claim.acknowledged, acknowledge_claimant task done, timer met.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootClaimsApp, claimInput, user } from './helpers.mjs';

const events = (app, type, tenant = 'alpha') => app.ctx.bus.outbox(tenant).map((o) => JSON.parse(o.event)).filter((e) => e.type === type);

test('claim.reported acknowledges the claimant and meets the acknowledge timer', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims('gamma');
  const c = await svc.createClaim(claimInput({ riskState: 'IL', lossEvent: { ...claimInput().lossEvent, location: undefined } }), { actor: user('csr') });
  await app.ctx.bus.drain();

  const timer = (await svc.listTimers(c.id)).find((x) => x.definitionId === 'IL-ACK');
  assert.equal(timer.status, 'met');
  assert.ok(timer.metAt);

  const tasks = await svc.listTasks(c.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'done');

  const [ev] = events(app, 'claim.acknowledged', 'gamma');
  assert.ok(ev, 'claim.acknowledged published');
  assert.equal(ev.data.claimId, c.id);
  assert.equal(ev.data.channel, 'sms', 'first configured claimant channel');

  const entry = app.ctx.audit.list('gamma', { entityId: c.id, action: 'claim.acknowledged' })[0];
  assert.ok(entry, 'acknowledgment audit entry');
  assert.equal(entry.details.channel, 'sms');
  assert.equal(entry.details.delivery, 'recorded_only');
});

test('acknowledgment is idempotent and skipped for tenants without a claimant channel', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims('gamma');
  const c = await svc.createClaim(claimInput({ riskState: 'IL', lossEvent: { ...claimInput().lossEvent, location: undefined } }), { actor: user('csr') });
  await app.ctx.bus.drain();
  assert.equal(await svc.acknowledgeClaim(c.id), null, 'second call is a no-op');
  assert.equal((await svc.listTasks(c.id)).length, 1);
  assert.equal(events(app, 'claim.acknowledged', 'gamma').length, 1);

  const b = await app.claims('beta').createClaim(claimInput(), { actor: user('csr') });
  await app.ctx.bus.drain();
  assert.equal((await app.claims('beta').listTasks(b.id)).length, 0);
  assert.equal(events(app, 'claim.acknowledged', 'beta').length, 0);
});
