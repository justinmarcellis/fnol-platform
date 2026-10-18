import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootClaimsApp, claimInput, user, call } from './helpers.mjs';

const eventsOf = (app, type, tenant = 'alpha') => app.ctx.bus.outbox(tenant).map((o) => JSON.parse(o.event)).filter((e) => e.type === type);

test('createClaim: shape, claim.reported payload, audit, sequence per tenant, idempotency', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const c = await svc.createClaim(claimInput(), { actor: user('csr'), idempotencyKey: 'k1' });
  assert.match(c.id, /^clm_[0-9a-f]{20}$/);
  assert.equal(c.tenantId, 'alpha');
  assert.equal(c.version, 1);
  assert.equal(c.status, 'reported');
  assert.deepEqual(c.checks, { coverage: 'pending', evidence: 'none' });
  assert.equal(c.parties.length, 1);
  assert.match(c.parties[0].id, /^pty_/);
  assert.equal(c.parties[0].claimId, c.id);

  const again = await svc.createClaim(claimInput(), { actor: user('csr'), idempotencyKey: 'k1' });
  assert.equal(again.id, c.id);
  const second = await svc.createClaim(claimInput(), { actor: user('csr') });
  assert.equal(second.claimNumber, 'ALP-2026-000002');
  assert.equal((await app.claims('beta').createClaim(claimInput(), { actor: user('csr') })).claimNumber, 'BET-2026-000001');

  const rep = eventsOf(app, 'claim.reported').filter((e) => e.data.claimId === c.id);
  assert.equal(rep.length, 1);
  assert.equal(rep[0].tenantid, 'alpha');
  assert.deepEqual(rep[0].data, {
    claimId: c.id, claimNumber: c.claimNumber, lob: 'personal_auto', lossType: 'auto_collision', channel: 'api', policyNumber: 'POL-100200',
    lossDate: '2026-02-28', lossCause: 'collision', riskState: 'WI', injuriesReported: false, vehiclesInvolved: 2, documentCount: 0, reportedAt: c.reportedAt,
  });
  assert.equal(app.tctx().audit.list({ action: 'claim.created', entityId: c.id }).length, 1);
});

test('createClaim validation and tenant mismatch', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  await assert.rejects(svc.createClaim({}, {}), { code: 'validation_failed', status: 422 });
  await assert.rejects(svc.createClaim(claimInput({ channel: 'carrier_pigeon' }), {}), { code: 'validation_failed' });
  await assert.rejects(svc.createClaim(claimInput({ tenantId: 'beta' }), {}), { code: 'tenant_mismatch', status: 403 });
  await assert.rejects(svc.createClaim(claimInput({ parties: [{ kind: 'person' }] }), {}), { code: 'validation_failed' });
  assert.equal((await app.ctx.db.forTenant('alpha').get('SELECT COUNT(*) AS n FROM claims')).n, 0);
});

test('claim.checks are recorded from coverage, evidence and triage events', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const c = await svc.createClaim(claimInput(), { actor: user('csr') });
  await app.ctx.bus.drain();

  await app.emit('claim.evidence.added', c.id, { documentId: 'doc_00000001', kind: 'photo', contentType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64) });
  let cur = await svc.getClaim(c.id);
  assert.equal(cur.checks.evidence, 'pending');
  assert.deepEqual(cur.documentIds, ['doc_00000001']);

  await app.emit('claim.evidence.extracted', c.id, { documentId: 'doc_00000001', extractionId: 'ext_00000001', status: 'completed' });
  await app.emit('claim.evidence.extracted', c.id, { documentId: 'doc_00000002', extractionId: 'ext_00000002', status: 'failed' });
  cur = await svc.getClaim(c.id);
  assert.equal(cur.checks.evidence, 'failed');
  assert.deepEqual(cur.documentIds, ['doc_00000001', 'doc_00000002']);

  await app.emit('claim.coverage.verified', c.id, { verificationId: 'cov_00000009', policySnapshotId: 'pol_00000001', outcome: 'policy_not_found' });
  cur = await svc.getClaim(c.id);
  assert.equal(cur.checks.coverage, 'policy_not_found');
  assert.equal(cur.checks.coverageVerificationId, 'cov_00000009');
  assert.equal(cur.policySnapshotId, 'pol_00000001');
  assert.equal(cur.status, 'validating', 'checks do not move the status');

  await app.emit('claim.triaged', c.id, { triageResultId: 'tri_00000001', attempt: 1, severityScore: 77, complexity: 'high', fraudScore: 12, subrogation: true });
  cur = await svc.getClaim(c.id);
  assert.deepEqual(cur.triage, { resultId: 'tri_00000001', severityScore: 77, complexity: 'high', fraudScore: 12, subrogation: true });
  assert.equal(cur.status, 'triaged');
  assert.deepEqual((await svc.listClaims({ severityMin: 70 }, {})).items.map((x) => x.id), [c.id]);
  assert.equal((await svc.listClaims({ severityMin: 80 }, {})).items.length, 0);

  // re-triage keeps the status and updates the result; replay of the same event id is a no-op
  const evt = await app.emit('claim.triaged', c.id, { triageResultId: 'tri_00000002', attempt: 2, severityScore: 30, complexity: 'low', fraudScore: 0, subrogation: false });
  cur = await svc.getClaim(c.id);
  assert.equal(cur.triage.severityScore, 30);
  assert.equal(cur.status, 'triaged');
  const v = cur.version;
  await app.ctx.bus.drain();
  assert.equal((await svc.getClaim(c.id)).version, v);
  assert.ok(evt.id);
  // events for unknown claims are ignored, not errors
  await app.emit('claim.coverage.verified', 'clm_doesnotexist0001', { verificationId: 'cov_00000010', outcome: 'covered' });
  assert.equal(app.ctx.bus.outbox('alpha', 'failed').length, 0);
});

test('every mutation writes an audit entry and an event, with no PII in either', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const c = await svc.createClaim(claimInput(), { actor: user('csr') });
  const mark = () => ({ a: app.tctx().audit.list({ limit: 1000 }).length, e: app.ctx.bus.outbox('alpha').length });
  const step = async (name, fn, auditAction, eventType) => {
    const before = mark();
    await fn();
    const after = mark();
    assert.ok(after.a > before.a, `${name}: audit entry`);
    assert.ok(after.e > before.e, `${name}: event`);
    assert.ok(app.tctx().audit.list({ action: auditAction, limit: 1000 }).length >= 1, `${name}: action ${auditAction}`);
    assert.ok(eventsOf(app, eventType).length >= 1, `${name}: event ${eventType}`);
  };
  await step('flag', () => svc.addFlag(c.id, 'injury', { actor: user('csr') }), 'claim.flag.added', 'claim.updated');
  await step('note', () => svc.addNote(c.id, { body: 'Zelda said hello' }, { actor: user('csr') }), 'claim.note.added', 'claim.note.added');
  const task = await svc.addTask(c.id, { type: 'inspect', title: 'Inspect vehicle' }, { actor: user('adjuster'), sourceRuleId: 'R-1' });
  assert.equal(task.sourceRuleId, 'R-1');
  await step('task update', () => svc.updateTask(c.id, task.id, { status: 'in_progress', assigneeId: 'adj7' }, { actor: user('adjuster') }), 'claim.task.updated', 'claim.updated');
  await step('external ref', () => svc.setExternalRef(c.id, { system: 'core-claims-suite', id: 'CS-1', status: 'synced' }, { actor: user('csr') }), 'claim.external_ref.set', 'claim.updated');
  await step('reserve', () => svc.suggestReserve(c.id, { costType: 'indemnity', amount: { amount: 2500, currency: 'USD' } }, { actor: user('adjuster') }), 'claim.reserve.suggested', 'claim.updated');
  await step('status', () => svc.changeStatus(c.id, { to: 'withdrawn', actor: user('csr') }), 'claim.status.changed', 'claim.status.changed');

  const blob = JSON.stringify(app.ctx.bus.outbox('alpha').map((o) => o.event)) + JSON.stringify(app.tctx().audit.list({ limit: 1000 }));
  for (const s of ['Zelda', 'Quartz', 'hello', 'Birch', 'zelda.quartz']) assert.ok(!blob.includes(s), `${s} leaked into events/audit`);
  assert.equal(eventsOf(app, 'claim.note.added')[0].data.claimId, c.id);
});

test('flags, tasks, external refs, reserve, notes ordering', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const c = await svc.createClaim(claimInput(), { actor: user('csr') });
  const f1 = await svc.addFlag(c.id, 'injury', { actor: user('csr') });
  const f2 = await svc.addFlag(c.id, 'injury', { actor: user('csr') });
  assert.deepEqual(f2.flags, ['injury']);
  assert.equal(f2.version, f1.version, 'adding an existing flag is a no-op');
  await assert.rejects(svc.addFlag(c.id, 'Not A Flag', {}), { code: 'validation_failed' });

  await svc.addNote(c.id, { body: 'first' }, { actor: user('csr') });
  await svc.addNote(c.id, { body: 'second', category: 'coverage', ai: { provider: 'local', model: 'local-rules-v1', confidence: 0.9 } }, { actor: user('adjuster') });
  const notes = await svc.listNotes(c.id);
  assert.deepEqual(notes.map((n) => n.body), ['second', 'first'], 'newest first');
  assert.equal(eventsOf(app, 'claim.note.added').at(-1).data.aiGenerated, true);
  await assert.rejects(svc.addNote(c.id, { body: '' }, {}), { code: 'validation_failed' });
  await assert.rejects(svc.addNote(c.id, { body: 'x', category: 'nope' }, {}), { code: 'validation_failed' });

  const ref = await svc.setExternalRef(c.id, { system: 'core-claims-suite', id: 'CS-9', status: 'synced' }, {});
  assert.equal(ref.externalRefs[0].status, 'synced');
  assert.ok(ref.externalRefs[0].syncedAt);
  const ref2 = await svc.setExternalRef(c.id, { system: 'core-claims-suite', id: 'CS-9', status: 'failed' }, {});
  assert.equal(ref2.externalRefs.length, 1);

  const r = await svc.suggestReserve(c.id, { costType: 'expense' }, { actor: user('adjuster') });
  assert.equal(r.status, 'suggested');
  assert.equal(r.amount.currency, 'USD');
  const t1 = await svc.addTask(c.id, { title: 'A' }, { actor: user('csr') });
  await svc.addTask(c.id, { title: 'B', priority: 'urgent' }, { actor: user('csr') });
  assert.deepEqual((await svc.listTasks(c.id)).map((x) => x.title), ['A', 'B']);
  assert.equal(t1.type, 'other');
  await assert.rejects(svc.addTask(c.id, { title: 'bad', priority: 'p0' }, {}), { code: 'validation_failed' });
});

test('listClaims: filters, sort and cursor paging', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    app.clock.advance(1000);
    ids.push((await svc.createClaim(claimInput({ lob: i % 2 ? 'homeowners' : 'personal_auto', policyNumber: `POL-${100 + i}` }), { actor: user('csr') })).id);
  }
  await svc.addFlag(ids[1], 'cat', {});
  await svc.changeStatus(ids[0], { to: 'withdrawn', actor: user('csr') });
  const all = await svc.listClaims({}, {});
  assert.deepEqual(all.items.map((c) => c.id), [...ids].reverse(), 'default sort is -reportedAt');
  assert.equal(all.items[0].parties, undefined, 'summary form omits parties');
  assert.deepEqual((await svc.listClaims({ sort: 'reportedAt' }, {})).items.map((c) => c.id), ids);
  assert.equal((await svc.listClaims({ lob: 'homeowners' }, {})).items.length, 2);
  assert.deepEqual((await svc.listClaims({ status: 'withdrawn' }, {})).items.map((c) => c.id), [ids[0]]);
  assert.equal((await svc.listClaims({ status: 'withdrawn,reported' }, {})).items.length, 5);
  assert.deepEqual((await svc.listClaims({ flag: 'cat' }, {})).items.map((c) => c.id), [ids[1]]);
  assert.deepEqual((await svc.listClaims({ q: 'POL-103' }, {})).items.map((c) => c.id), [ids[3]]);
  assert.equal((await svc.listClaims({ q: 'ALP-2026-00000' }, {})).items.length, 5);
  assert.equal((await svc.listClaims({ riskState: 'IL' }, {})).items.length, 0);

  const p1 = await svc.listClaims({}, { limit: 2 });
  assert.equal(p1.items.length, 2);
  assert.ok(p1.nextCursor);
  const p2 = await svc.listClaims({}, { limit: 2, cursor: p1.nextCursor });
  const p3 = await svc.listClaims({}, { limit: 2, cursor: p2.nextCursor });
  assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map((c) => c.id), [...ids].reverse());
  assert.equal(p3.nextCursor, null);
  await assert.rejects(svc.listClaims({}, { cursor: 'garbage' }), { code: 'bad_cursor' });
});

test('tenant isolation in the service', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const c = await app.claims('alpha').createClaim(claimInput(), { actor: user('csr') });
  const beta = app.claims('beta');
  await assert.rejects(beta.getClaim(c.id), { code: 'not_found' });
  await assert.rejects(beta.addFlag(c.id, 'injury', {}), { code: 'not_found' });
  await assert.rejects(beta.changeStatus(c.id, { to: 'withdrawn', actor: user('supervisor') }), { code: 'not_found' });
  await assert.rejects(beta.listTimers(c.id), { code: 'not_found' });
  assert.equal((await beta.listClaims({}, {})).items.length, 0);
});

test('HTTP routes follow openapi /claims paths', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const csr = app.token(['csr']);
  const adj = app.token(['adjuster']);
  const sup = app.token(['supervisor']);

  assert.equal((await call(app, 'POST', '/api/v1/claims', { body: claimInput() })).status, 401);
  assert.equal((await call(app, 'POST', '/api/v1/claims', { token: adj, body: claimInput() })).status, 403);
  const bad = await call(app, 'POST', '/api/v1/claims', { token: csr, body: { lob: 'personal_auto' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, 'validation_failed');
  const mismatch = await call(app, 'POST', '/api/v1/claims', { token: csr, body: claimInput({ tenantId: 'beta' }) });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.json.error.code, 'tenant_mismatch');

  const created = await call(app, 'POST', '/api/v1/claims', { token: csr, body: claimInput(), headers: { 'idempotency-key': 'abc' } });
  assert.equal(created.status, 201);
  const id = created.json.id;
  assert.equal(created.headers.get('location'), `/api/v1/claims/${id}`);
  assert.equal(created.json.parties[0].lastName, 'Quartz');
  const replay = await call(app, 'POST', '/api/v1/claims', { token: csr, body: claimInput(), headers: { 'idempotency-key': 'abc' } });
  assert.equal(replay.json.id, id);

  const got = await call(app, 'GET', `/api/v1/claims/${id}`, { token: csr });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('etag'), `"${got.json.version}"`);
  assert.equal((await call(app, 'GET', '/api/v1/claims/clm_nope', { token: csr })).status, 404);
  assert.equal((await call(app, 'GET', `/api/v1/claims/${id}`, { token: app.token(['csr'], 'beta') })).status, 404, 'other tenant');

  const list = await call(app, 'GET', '/api/v1/claims?status=reported,validating&lob=personal_auto&limit=1', { token: adj });
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 1);
  assert.ok(list.json.nextCursor === null || typeof list.json.nextCursor === 'string');
  assert.equal(list.json.items[0].lossEvent.description.length > 0, true);

  await app.ctx.bus.drain();
  const st = (token, body, headers) => call(app, 'POST', `/api/v1/claims/${id}/status`, { token, body, headers });
  assert.equal((await st(csr, { to: 'bogus' })).status, 422);
  assert.equal((await st(adj, { to: 'in_review' })).json.error.code, 'invalid_transition');
  assert.equal((await st(csr, { to: 'withdrawn' }, { 'if-match': '999' })).json.error.code, 'version_conflict');
  const w = await st(csr, { to: 'withdrawn', reason: 'duplicate report' }, { 'if-match': `"${(await call(app, 'GET', `/api/v1/claims/${id}`, { token: csr })).json.version}"` });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  assert.equal(w.json.status, 'withdrawn');

  const timers = await call(app, 'GET', `/api/v1/claims/${id}/timers`, { token: sup });
  assert.equal(timers.status, 200);
  assert.equal(timers.json.items.length, 2);
  const nt = await call(app, 'POST', `/api/v1/claims/${id}/notes`, { token: csr, body: { body: 'n1' } });
  assert.equal(nt.status, 201);
  assert.equal((await call(app, 'POST', `/api/v1/claims/${id}/notes`, { token: csr, body: {} })).status, 422);
  const tasks = await call(app, 'GET', `/api/v1/claims/${id}/tasks`, { token: sup });
  assert.deepEqual(tasks.json, { items: [] });

  const t1 = await app.claims().addTask(id, { type: 'inspect', title: 'Look' }, { actor: user('adjuster') });
  assert.equal((await call(app, 'PATCH', `/api/v1/claims/${id}/tasks/${t1.id}`, { token: csr, body: { status: 'done' } })).status, 403);
  const upd = await call(app, 'PATCH', `/api/v1/claims/${id}/tasks/${t1.id}`, { token: adj, body: { status: 'done', assigneeId: 'adj1' } });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.status, 'done');
  assert.equal((await call(app, 'PATCH', `/api/v1/claims/${id}/tasks/tsk_missing00`, { token: adj, body: { status: 'done' } })).status, 404);
});
