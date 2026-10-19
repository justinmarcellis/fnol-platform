import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootClaimsApp, call, claimInput, user } from './helpers.mjs';
import { projectClaim, isStaff } from '../../../src/modules/claims/projection.mjs';

const claimantActor = (id) => ({ type: 'user', id, role: 'claimant', roles: ['claimant'] });

async function seed(app) {
  const svc = app.claims();
  const mine = await svc.createClaim(claimInput(), { actor: claimantActor('cl-1') });
  const other = await svc.createClaim(claimInput(), { actor: claimantActor('cl-2') });
  // Staff-only data written onto the stored doc the way triage and routing do.
  const db = app.tctx().db;
  const row = db.get('SELECT doc FROM claims WHERE id = ?', mine.id);
  const doc = JSON.parse(row.doc);
  doc.triage = { fraudScore: 91, severityScore: 77 };
  doc.routing = { queue: 'siu', adjusterId: 'adj-9' };
  doc.reserves = { indemnity: 5000 };
  db.run('UPDATE claims SET doc = ? WHERE id = ?', JSON.stringify(doc), mine.id);
  await svc.addFlag(mine.id, 'siu', { actor: user('adjuster') });
  return { mine, other };
}

test('projectClaim whitelists fields and drops unknown ones', () => {
  const p = projectClaim({ id: 'c1', status: 'reported', triage: { fraudScore: 1 }, flags: ['siu'], routing: {}, notes: [], lossEvent: { lossDate: 'd', cause: 'x', description: 'secret' }, extra: 1 });
  assert.deepEqual(Object.keys(p).sort(), ['id', 'lossEvent', 'status']);
  assert.deepEqual(p.lossEvent, { lossDate: 'd', cause: 'x' });
  assert.equal(isStaff({ roles: ['claimant'] }), false);
  assert.equal(isStaff({ roles: ['agent'] }), false);
  assert.equal(isStaff({ roles: ['adjuster'] }), true);
});

test('claimant reads only own claim, projected; foreign claim is 404', async (t) => {
  const app = await bootClaimsApp(); t.after(() => app.close());
  const { mine, other } = await seed(app);
  const token = app.token(['claimant'], 'alpha', 'cl-1');
  const r = await call(app, 'GET', `/api/v1/claims/${mine.id}?include=parties`, { token });
  assert.equal(r.status, 200);
  for (const leak of ['fraud', 'siu', 'severity', 'adjuster', 'reserves', 'routing', 'triage', 'flags', 'notes', 'parties']) {
    assert.ok(!r.text.toLowerCase().includes(leak), `leaked ${leak}`);
  }
  assert.equal(r.json.claimNumber, mine.claimNumber);
  assert.ok(r.json.status);
  assert.equal((await call(app, 'GET', `/api/v1/claims/${other.id}`, { token })).status, 404);
  // staff still see the full claim
  const staff = await call(app, 'GET', `/api/v1/claims/${mine.id}`, { token: app.token(['adjuster']) });
  assert.equal(staff.json.triage.fraudScore, 91);
});

test('status event and history carry no free text; history reason is encrypted', async (t) => {
  const app = await bootClaimsApp(); t.after(() => app.close());
  const { mine } = await seed(app);
  const seen = [];
  app.ctx.bus.subscribe?.('claim.status.changed', (e) => seen.push(e));
  const adj = app.token(['supervisor'], 'alpha', 'sup-1');
  const r = await call(app, 'POST', `/api/v1/claims/${mine.id}/status`, { token: adj, body: { to: 'withdrawn', reason: 'Zelda said call 608 555 0142', reasonCode: 'awaiting_documents' } });
  assert.equal(r.status, 200);
  await app.ctx.bus.drain();
  const db = app.tctx().db;
  const rows = db.all('SELECT reason FROM claim_status_history WHERE claim_id = ?', mine.id);
  assert.ok(!JSON.stringify(rows).includes('Zelda'));
  const ev = db.all('SELECT * FROM outbox').map((x) => JSON.stringify(x)).join('');
  assert.ok(!ev.includes('Zelda') && !ev.includes('608 555'));
  assert.ok(ev.includes('awaiting_documents'));
  const hist = await app.claims().listStatusHistory(mine.id, { decrypt: true });
  const last = hist.at(-1);
  assert.equal(last.reasonCode, 'awaiting_documents');
  assert.equal(last.reason, 'Zelda said call 608 555 0142');
  assert.equal((await app.claims().listStatusHistory(mine.id)).at(-1).reason, undefined);
  const bad = await call(app, 'POST', `/api/v1/claims/${mine.id}/status`, { token: adj, body: { to: 'withdrawn', reasonCode: 'Free text here' } });
  assert.equal(bad.status, 422);
});

test('notes ignore body.ai', async (t) => {
  const app = await bootClaimsApp(); t.after(() => app.close());
  const { mine } = await seed(app);
  const r = await call(app, 'POST', `/api/v1/claims/${mine.id}/notes`, { token: app.token(['adjuster']), body: { body: 'called insured', ai: { provider: 'x', model: 'y', confidence: 1 } } });
  assert.equal(r.status, 201);
  assert.equal(r.json.ai, undefined);
  const notes = await call(app, 'GET', `/api/v1/claims/${mine.id}/notes`, { token: app.token(['adjuster']) });
  assert.ok(notes.json.items.every((n) => n.ai === undefined));
});

test('carrier_admin is not a routing POST role (rules routes WRITE)', async () => {
  const { registerRoutes } = await import('../../../src/modules/rules/routes.js');
  const reg = [];
  const rec = (method) => (path, _h, opts) => reg.push({ method, path, roles: opts.roles });
  registerRoutes({ get: rec('get'), post: rec('post') });
  const post = reg.find((r) => r.method === 'post' && r.path.endsWith('/routing'));
  assert.ok(post.roles.includes('supervisor') && post.roles.includes('adjuster'));
  assert.ok(!post.roles.includes('carrier_admin'));
});
