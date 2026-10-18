import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createApp } from '../../../src/server.mjs';
import { validate, fileResolver } from '../../../src/modules/config/validator.js';
import { fakeModules, reset, put, CLAIM_ID, TS, makeClaim, makeTriage, makeCoverage } from './fakes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const adjusterEntry = pathToFileURL(path.join(root, 'src/modules/adjuster/index.mjs')).href;
const fakesUrl = pathToFileURL(path.join(here, 'fakes.mjs')).href;
const viewSchema = JSON.parse(fs.readFileSync(path.join(root, 'architecture/contracts/domain/AdjusterView.schema.json'), 'utf8'));
const assertValid = (doc) => {
  const r = validate(viewSchema, doc, { resolve: fileResolver() });
  assert.deepEqual(r.errors, []);
};

let app; let dir; let aiCalls;
const fakeAi = {
  async run(task, input, opts) {
    aiCalls.push({ task, input, opts });
    if (task === 'summarize') return { output: { summary: 'Rear-end collision, moderate damage.', bullets: ['Covered'] }, provider: 'local', model: 'local-rules-v1', confidence: 0.9, explanation: 'ok', usage: {}, tier: 0 };
    return { output: { actions: [{ code: 'call_shop', label: 'Call the repair shop', reason: 'Estimate pending', priority: 'low' }] }, provider: 'local', model: 'local-rules-v1', confidence: 0.9, explanation: 'ok', usage: {}, tier: 0 };
  },
};

async function boot(modules = ['claims', 'evidence', 'coverage', 'triage', 'rules']) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-adj-'));
  const modulesDir = path.join(dir, 'modules');
  const mods = [['adjuster', `export { default } from '${adjusterEntry}';`],
    ...modules.map((m) => [m, `import { fakeModules } from '${fakesUrl}'; export default fakeModules.${m};`])];
  for (const [name, src] of mods) {
    fs.mkdirSync(path.join(modulesDir, name), { recursive: true });
    fs.writeFileSync(path.join(modulesDir, name, 'index.mjs'), `${src}\n`);
  }
  const tenantsDir = path.join(dir, 'tenants');
  fs.mkdirSync(tenantsDir);
  for (const id of ['alpha', 'beta']) fs.writeFileSync(path.join(tenantsDir, `${id}.json`), JSON.stringify({ id, displayName: `${id} Example` }));
  const a = await createApp({ dbPath: ':memory:', port: 0, secretsDir: path.join(dir, 's'), tenantsDir, modulesDir, logLevel: 'silent' });
  a.ctx.ai = fakeAi;
  return a;
}
const close = async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); };

before(async () => { app = await boot(); });
after(close);
beforeEach(() => {
  reset(); aiCalls = [];
  for (const tbl of ['adjuster_summaries', 'adjuster_inbox']) app.ctx.db.raw.exec(`DELETE FROM ${tbl}`);
});

const adj = (t = 'alpha') => app.ctx.forTenant(t).modules.adjuster;
const tok = (roles, tenantId = 'alpha', sub = 'adj1') => app.ctx.auth.issueToken({ sub, tenantId, roles });
const get = async (url, token) => {
  const res = await fetch(app.url + url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const seedClaim = () => {
  put('claims', 'alpha', CLAIM_ID, makeClaim());
  put('triage', 'alpha', CLAIM_ID, makeTriage(1));
  put('cov', 'alpha', CLAIM_ID, makeCoverage('covered'));
  put('timers', 'alpha', CLAIM_ID, [{ id: 'tmr_00000000000000000001', tenantId: 'alpha', claimId: CLAIM_ID, state: 'WI', kind: 'contact', status: 'due_soon', startedAt: TS, dueAt: TS }]);
  put('docs', 'alpha', CLAIM_ID, [{ id: 'doc_00000000000000000001', tenantId: 'alpha', claimId: CLAIM_ID, kind: 'photo', filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64), uploadedAt: TS }]);
  put('routing', 'alpha', CLAIM_ID, { id: 'rte_00000000000000000001', tenantId: 'alpha', claimId: CLAIM_ID, outcome: 'assigned', queue: 'auto-std', adjusterId: 'adj1', fastTrack: false, ruleIds: [], decidedAt: TS });
};

test('getFirstView returns a schema-valid doc with all sections', async () => {
  seedClaim();
  app.ctx.bus.publish('alpha', 'claim.status.changed', CLAIM_ID, { claimId: CLAIM_ID, from: 'triaged', to: 'assigned', version: 3 });
  await app.ctx.bus.drain();
  const v = await adj().getFirstView(CLAIM_ID, { actor: 'adj1' });
  assertValid(v);
  assert.equal(v.summary.ai.provider, 'local');
  assert.match(v.summary.text, /collision/);
  assert.equal(v.routing.queue, 'auto-std');
  assert.equal(v.documents.length, 1);
  assert.ok(v.timeline.some((t) => t.type === 'claim.status.changed' && /triaged to assigned/.test(t.label)));
  assert.ok(v.claim.flags.includes('timer_due'));
  const codes = v.nextActions.map((a) => a.code);
  assert.ok(codes.includes('request_police_report'));
  assert.ok(codes.includes('timer_contact_due'));
  assert.ok(codes.includes('call_shop'));
  assert.ok(!codes.includes('verify_coverage'));
  assert.equal(v.nextActions.find((a) => a.code === 'call_shop').source, 'ai');
});

test('summary is cached per triage attempt', async () => {
  seedClaim();
  await adj().getFirstView(CLAIM_ID);
  await adj().getFirstView(CLAIM_ID);
  assert.equal(aiCalls.filter((c) => c.task === 'summarize').length, 1);
  put('triage', 'alpha', CLAIM_ID, makeTriage(2));
  await adj().getFirstView(CLAIM_ID);
  assert.equal(aiCalls.filter((c) => c.task === 'summarize').length, 2);
  assert.ok(aiCalls.every((c) => c.opts.tenantId === 'alpha'));
});

test('unverified coverage and missing police report produce rule actions; no PII in AI facts', async () => {
  put('claims', 'alpha', CLAIM_ID, makeClaim({ parties: [{ id: 'pty_00000000000000000001', tenantId: 'alpha', claimId: CLAIM_ID, roles: ['insured'], kind: 'person', firstName: 'Zed', lastName: 'Fictional' }] }));
  const v = await adj().getFirstView(CLAIM_ID);
  assertValid(v);
  const codes = v.nextActions.map((a) => a.code);
  assert.ok(codes.includes('verify_coverage'));
  assert.ok(codes.includes('request_police_report'));
  assert.ok(!JSON.stringify(aiCalls).includes('Fictional'));
});

test('unknown claim is 404; ai failure still yields a valid view', async () => {
  await assert.rejects(() => adj().getFirstView('clm_missing'), (e) => e.status === 404);
  seedClaim();
  const saved = app.ctx.ai;
  app.ctx.ai = { run: async () => { throw new Error('down'); } };
  const v = await adj().getFirstView(CLAIM_ID);
  app.ctx.ai = saved;
  assertValid(v);
  assert.equal(v.summary, undefined);
  assert.ok(v.nextActions.length > 0);
});

test('view tolerates absent sibling modules', async () => {
  const solo = await (async () => { const old = { app, dir }; app = await boot(['claims']); const r = { a: app, d: dir }; app = old.app; dir = old.dir; return r; })();
  put('claims', 'alpha', CLAIM_ID, makeClaim());
  const v = await solo.a.ctx.forTenant('alpha').modules.adjuster.getFirstView(CLAIM_ID);
  assertValid(v);
  await solo.a.close();
  fs.rmSync(solo.d, { recursive: true, force: true });
});

test('inbox projection follows claim events; filters and cursor pagination', async () => {
  const bus = app.ctx.bus;
  for (let i = 1; i <= 3; i++) {
    const id = `clm_0000000000000000000${i}`;
    bus.publish('alpha', 'claim.reported', id, { claimId: id, claimNumber: `ALP-26-00000${i}`, lob: 'personal_auto', channel: 'web', lossDate: '2026-09-15', lossCause: 'collision', reportedAt: TS });
    bus.publish('alpha', 'claim.triaged', id, { claimId: id, triageResultId: 'trg_1', attempt: 1, severityScore: i * 10, complexity: 'low', fraudScore: i === 3 ? 90 : 5, subrogation: i === 2, ai: {} });
    bus.publish('alpha', 'claim.routed', id, { claimId: id, decisionId: 'rte_1', outcome: 'assigned', queue: i === 3 ? 'siu' : 'auto-std', adjusterId: i === 1 ? 'adj2' : 'adj1', ruleIds: [] });
  }
  bus.publish('alpha', 'claim.timer.breached', 'clm_00000000000000000002', { claimId: 'clm_00000000000000000002', timerId: 'tmr_1', state: 'WI', kind: 'contact', dueAt: '2026-09-16T09:00:00.000Z' });
  bus.publish('alpha', 'claim.status.changed', 'clm_00000000000000000001', { claimId: 'clm_00000000000000000001', from: 'assigned', to: 'in_review', version: 4 });
  bus.publish('beta', 'claim.reported', 'clm_b', { claimId: 'clm_b', claimNumber: 'BET-1', lob: 'homeowners', channel: 'web', lossDate: '2026-09-15', lossCause: 'fire', reportedAt: TS });
  await bus.drain();

  const all = adj().getInbox({});
  assert.equal(all.items.length, 3);
  const mine = adj().getInbox({ adjusterId: 'adj1' });
  assert.deepEqual(mine.items.map((r) => r.claimId), ['clm_00000000000000000002', 'clm_00000000000000000003']); // timer first
  assert.deepEqual(mine.items[0].flags.sort(), ['subrogation', 'timer_breached']);
  assert.equal(mine.items[0].nextTimer.status, 'breached');
  assert.ok(mine.items[1].flags.includes('siu'));
  assert.equal(adj().getInbox({ queue: 'siu' }).items.length, 1);
  assert.equal(adj().getInbox({ adjusterId: 'adj2' }).items[0].status, 'in_review');

  const p1 = adj().getInbox({ limit: 2 });
  assert.equal(p1.items.length, 2);
  assert.ok(p1.nextCursor);
  const p2 = adj().getInbox({ limit: 2, cursor: p1.nextCursor });
  assert.equal(p2.items.length, 1);
  assert.equal(p2.nextCursor, null);

  assert.equal(adj('beta').getInbox({}).items.length, 1);
  assert.equal(adj('beta').getInbox({}).items[0].claimNumber, 'BET-1');
});

test('routes: roles, inbox mine/queue, view, 404, tenant isolation', async () => {
  seedClaim();
  app.ctx.bus.publish('alpha', 'claim.routed', CLAIM_ID, { claimId: CLAIM_ID, decisionId: 'r', outcome: 'assigned', queue: 'q1', adjusterId: 'adj1', ruleIds: [] });
  await app.ctx.bus.drain();

  assert.equal((await get('/api/v1/adjuster/inbox')).status, 401);
  assert.equal((await get('/api/v1/adjuster/inbox', tok(['claimant']))).status, 403);
  const inbox = await get('/api/v1/adjuster/inbox', tok(['adjuster']));
  assert.equal(inbox.status, 200);
  assert.equal(inbox.json.items.length, 1);
  assert.equal((await get('/api/v1/adjuster/inbox', tok(['adjuster'], 'alpha', 'other'))).json.items.length, 0);
  assert.equal((await get('/api/v1/adjuster/inbox?mine=false&queue=q1', tok(['supervisor'], 'alpha', 'other'))).json.items.length, 1);
  assert.equal((await get('/api/v1/adjuster/inbox?limit=0', tok(['adjuster']))).status, 400);

  const view = await get(`/api/v1/adjuster/claims/${CLAIM_ID}/view`, tok(['adjuster']));
  assert.equal(view.status, 200);
  assertValid(view.json);
  assert.equal((await get('/api/v1/adjuster/claims/clm_nope/view', tok(['supervisor']))).status, 404);
  assert.equal((await get(`/api/v1/adjuster/claims/${CLAIM_ID}/view`, tok(['adjuster'], 'beta'))).status, 404);
});
