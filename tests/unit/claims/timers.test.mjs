import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBusinessDays, addDuration, sweepTimers } from '../../../src/modules/claims/index.mjs';
import { bootClaimsApp, claimInput, user, T0 } from './helpers.mjs';

const DAY = 86400000;
const iso = (ms) => new Date(Date.parse(T0) + ms).toISOString();
const events = (app, type, tenant = 'alpha') => app.ctx.bus.outbox(tenant).map((o) => JSON.parse(o.event)).filter((e) => e.type === type);

test('business-day math skips weekends and holidays', () => {
  const fri = new Date('2026-03-06T12:00:00Z');
  assert.equal(addBusinessDays(fri, 1).toISOString(), '2026-03-09T12:00:00.000Z');
  assert.equal(addBusinessDays(new Date('2026-03-02T12:00:00Z'), 4, ['2026-03-05']).toISOString(), '2026-03-09T12:00:00.000Z');
  assert.equal(addBusinessDays(new Date('2026-03-09T12:00:00Z'), -1).toISOString(), '2026-03-06T12:00:00.000Z');
  assert.equal(addDuration(fri, { value: 2, unit: 'hours' }).toISOString(), '2026-03-06T14:00:00.000Z');
});

test('timers start on claim.reported by risk state and LOB', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const c = await svc.createClaim(claimInput(), { actor: user('csr') });
  const list = await svc.listTimers(c.id);
  assert.deepEqual(list.map((x) => x.definitionId).sort(), ['WI-ACK', 'WI-CONTACT']);
  const ack = list.find((x) => x.definitionId === 'WI-ACK');
  assert.equal(ack.status, 'running');
  assert.equal(ack.kind, 'acknowledge');
  assert.equal(ack.state, 'WI');
  assert.equal(ack.startedAt, T0);
  assert.equal(ack.dueAt, iso(7 * DAY));
  assert.equal(ack.warnAt, iso(5 * DAY));
  const contact = list.find((x) => x.definitionId === 'WI-CONTACT');
  assert.equal(contact.dueAt, '2026-03-06T15:00:00.000Z', '3 business days from Mon 2026-03-02 skipping holiday 2026-03-05');

  // other state -> its own timer; commercial lob excluded from WI-ACK by lobs; no state -> none
  const il = await svc.createClaim(claimInput({ riskState: 'IL', lossEvent: { ...claimInput().lossEvent, location: undefined } }), { actor: user('csr') });
  assert.deepEqual((await svc.listTimers(il.id)).map((x) => x.definitionId), ['IL-ACK']);
  const comm = await svc.createClaim(claimInput({ lob: 'commercial_auto' }), { actor: user('csr') });
  assert.deepEqual((await svc.listTimers(comm.id)).map((x) => x.definitionId), ['WI-CONTACT']);
  const beta = await app.claims('beta').createClaim(claimInput(), { actor: user('csr') });
  assert.deepEqual(await app.claims('beta').listTimers(beta.id), []);

  // the claim.reported handler is idempotent with createClaim
  await app.ctx.bus.drain();
  assert.equal((await svc.listTimers(c.id)).length, 2);
});

test('sweepTimers publishes due once at warnAt and breached once at dueAt, then applies onBreach', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const c = await svc.createClaim(claimInput(), { actor: user('csr') });
  await app.ctx.bus.drain();

  assert.deepEqual(await sweepTimers(iso(1 * DAY), app.ctx), { due: [], breached: [] });
  const due = await sweepTimers(iso(5 * DAY + 1000), app.ctx);
  assert.equal(due.due.length, 1);
  assert.equal(due.breached.length, 1, 'WI-CONTACT (3 business days) is already past due by day 5');
  assert.deepEqual(await sweepTimers(iso(5 * DAY + 2000), app.ctx), { due: [], breached: [] }, 'nothing is re-published');

  let timers = await svc.listTimers(c.id);
  assert.equal(timers.find((x) => x.definitionId === 'WI-ACK').status, 'due_soon');
  assert.equal(events(app, 'claim.timer.due').length, 1);
  const d = events(app, 'claim.timer.due')[0].data;
  assert.equal(d.claimId, c.id);
  assert.equal(d.kind, 'acknowledge');
  assert.equal(d.definitionId, 'WI-ACK');

  const b = await sweepTimers(iso(7 * DAY), app.ctx);
  assert.equal(b.breached.length, 1);
  await sweepTimers(iso(30 * DAY), app.ctx);
  await app.ctx.bus.drain();
  assert.equal(events(app, 'claim.timer.breached').length, 2);
  assert.equal(events(app, 'claim.timer.due').length, 1);
  const br = events(app, 'claim.timer.breached').find((e) => e.data.definitionId === 'WI-ACK');
  assert.equal(br.data.dueAt, iso(7 * DAY));
  assert.equal(br.data.breachedAt, iso(7 * DAY));

  timers = await svc.listTimers(c.id);
  assert.ok(timers.every((x) => x.status === 'breached'));
  const claim = await svc.getClaim(c.id);
  assert.deepEqual(claim.flags.sort(), ['ack_breach', 'contact_breach']);
  assert.equal(claim.routing.queue, 'escalations');
  const tasks = await svc.listTasks(c.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].type, 'other');
  assert.equal(tasks[0].queue, 'auto_physical_damage');
  assert.equal(tasks[0].priority, 'high');
  assert.ok(tasks[0].timerId);
  assert.ok(app.tctx().audit.list({ action: 'claim.timer.breached' }).length === 2);
});

test('a direct jump past dueAt publishes breached only', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const c = await app.claims().createClaim(claimInput({ riskState: 'IL', lossEvent: { ...claimInput().lossEvent, location: undefined } }), { actor: user('csr') });
  const r = await sweepTimers(iso(2 * DAY), app.ctx);
  assert.equal(r.breached.length, 1);
  assert.equal(events(app, 'claim.timer.due').length, 0);
  assert.equal((await app.claims().listTimers(c.id))[0].status, 'breached');
});

test('status-based stopOn meets a timer; closing cancels the rest', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const c = await svc.createClaim(claimInput(), { actor: user('csr') });
  await app.ctx.bus.drain();
  await app.emit('claim.coverage.verified', c.id, { verificationId: 'cov_00000001', outcome: 'covered' });
  await app.emit('claim.triaged', c.id, { triageResultId: 'tri_00000001', attempt: 1, severityScore: 10, complexity: 'low', fraudScore: 0, subrogation: false });
  await app.emit('claim.routed', c.id, { decisionId: 'rte_00000001', outcome: 'assigned', queue: 'q', ruleIds: [] });
  const timers = await svc.listTimers(c.id);
  const ack = timers.find((x) => x.definitionId === 'WI-ACK');
  assert.equal(ack.status, 'met');
  assert.equal(ack.metAt, T0);
  assert.equal(timers.find((x) => x.definitionId === 'WI-CONTACT').status, 'running');
  assert.deepEqual((await sweepTimers(iso(60 * DAY), app.ctx)).breached.length, 1, 'only the unmet timer can breach');

  const c2 = await svc.createClaim(claimInput(), { actor: user('csr') });
  await app.ctx.bus.drain();
  await svc.changeStatus(c2.id, { to: 'withdrawn', actor: user('csr') });
  await app.ctx.bus.drain();
  assert.ok((await svc.listTimers(c2.id)).every((x) => x.status === 'cancelled'));
});

test('completing a matching task meets a timer (taskType stopOn)', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const c = await svc.createClaim(claimInput(), { actor: user('csr') });
  const task = await svc.addTask(c.id, { type: 'contact_insured', title: 'Call the insured' }, { actor: user('adjuster') });
  assert.equal(task.status, 'open');
  const other = await svc.addTask(c.id, { type: 'inspect', title: 'Inspect' }, { actor: user('adjuster') });
  await svc.updateTask(c.id, other.id, { status: 'done' }, { actor: user('adjuster') });
  assert.equal((await svc.listTimers(c.id)).find((x) => x.definitionId === 'WI-CONTACT').status, 'running');
  const done = await svc.updateTask(c.id, task.id, { status: 'done' }, { actor: user('adjuster') });
  assert.ok(done.completedAt);
  const contact = (await svc.listTimers(c.id)).find((x) => x.definitionId === 'WI-CONTACT');
  assert.equal(contact.status, 'met');
  assert.equal((await sweepTimers(iso(60 * DAY), app.ctx)).breached.length, 1);
  await assert.rejects(svc.updateTask(c.id, 'tsk_nope0000', { status: 'done' }, { actor: user('adjuster') }), { code: 'not_found' });
});

test('startOn / stopOn follow tenant config for other events', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const c = await svc.createClaim(claimInput(), { actor: user('csr') });
  await app.ctx.bus.drain();
  await app.emit('claim.coverage.verified', c.id, { verificationId: 'cov_00000001', outcome: 'covered' });
  let decide = (await svc.listTimers(c.id)).find((x) => x.definitionId === 'WI-DECIDE');
  assert.equal(decide.status, 'running');
  assert.equal(decide.kind, 'decide');
  assert.equal(decide.dueAt, iso(30 * DAY));
  await app.emit('claim.triaged', c.id, { triageResultId: 'tri_00000001', attempt: 1, severityScore: 10, complexity: 'low', fraudScore: 0, subrogation: false });
  decide = (await svc.listTimers(c.id)).find((x) => x.definitionId === 'WI-DECIDE');
  assert.equal(decide.status, 'met');
});

test('subscribe registers an unref 30 s sweep interval', async (t) => {
  const real = globalThis.setInterval;
  const calls = [];
  globalThis.setInterval = (fn, ms, ...rest) => { const h = real(fn, ms, ...rest); calls.push({ ms, h }); return h; };
  let app;
  try {
    app = await bootClaimsApp();
  } finally {
    globalThis.setInterval = real;
  }
  t.after(() => app.close());
  const sweep = calls.find((c) => c.ms === 30_000);
  assert.ok(sweep, 'a 30 000 ms interval was created');
  assert.equal(sweep.h.hasRef(), false, 'interval is unref-ed');
});
