// Regression tests for S6-BUG-03 (adjuster workbench bug bash, round 1): server side.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createApp } from '../../../src/server.mjs';
import { mergeActions, priorityBand, priorityRank, ruleActions, hasPoliceReport } from '../../../src/modules/adjuster/actions.mjs';
import { syntheticName } from '../../../src/modules/adjuster/directory.mjs';
import { FACTS_VERSION } from '../../../src/modules/adjuster/service.mjs';
import { fakeModules, reset, put, CLAIM_ID, TS, makeClaim, makeTriage, makeCoverage } from './fakes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const adjusterEntry = pathToFileURL(path.join(root, 'src/modules/adjuster/index.mjs')).href;
const fakesUrl = pathToFileURL(path.join(here, 'fakes.mjs')).href;

let app; let dir; let aiCalls;
const PROV = { provider: 'local', model: 'local-rules-v1', confidence: 0.9, tier: 0 };
let nbaActions = [];
const fakeAi = {
  async run(task, input, opts) {
    aiCalls.push({ task, input, opts });
    if (task === 'summarize') {
      const filed = input.facts.policeReport?.filed;
      return { output: { summary: 'A theft loss.', bullets: [filed ? `Police report: ${input.facts.policeReportNumber ?? 'filed'}` : 'No police report on file'] }, ...PROV, explanation: 'ok', unconfirmed: true };
    }
    return { output: { actions: nbaActions }, ...PROV, explanation: 'ok' };
  },
};

const TENANT = {
  id: 'alpha', displayName: 'Alpha Example',
  ai: { provider: 'local', humanConfirmRequired: true },
  queues: [{ id: 'auto-std', label: { en: 'Auto standard', es: 'Auto estándar' }, adjusters: ['adj1', 'adj2'] }],
  rules: [{ id: 'RT-AUTO', stage: 'routing', name: 'Auto default queue' }],
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-adjbb-'));
  const modulesDir = path.join(dir, 'modules');
  const mods = [['adjuster', `export { default } from '${adjusterEntry}';`],
    ...['claims', 'evidence', 'coverage', 'triage', 'rules'].map((m) => [m, `import { fakeModules } from '${fakesUrl}'; export default fakeModules.${m};`])];
  for (const [name, src] of mods) {
    fs.mkdirSync(path.join(modulesDir, name), { recursive: true });
    fs.writeFileSync(path.join(modulesDir, name, 'index.mjs'), `${src}\n`);
  }
  const tenantsDir = path.join(dir, 'tenants');
  fs.mkdirSync(tenantsDir);
  fs.writeFileSync(path.join(tenantsDir, 'alpha.json'), JSON.stringify(TENANT));
  app = await createApp({ dbPath: ':memory:', port: 0, secretsDir: path.join(dir, 's'), tenantsDir, modulesDir, logLevel: 'silent' });
  app.ctx.ai = fakeAi;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  reset(); aiCalls = []; nbaActions = [];
  for (const tbl of ['adjuster_summaries', 'adjuster_inbox']) app.ctx.db.raw.exec(`DELETE FROM ${tbl}`);
});

const adj = () => app.ctx.forTenant('alpha').modules.adjuster;
const theft = (over = {}) => makeClaim({
  lob: 'personal_auto', lossType: 'theft',
  lossEvent: { lossDate: '2026-07-13', cause: 'theft', description: 'synthetic', policeReport: { filed: true, agency: 'Example PD (fictional)', reportNumber: 'RB-1' } },
  vehicles: [{ id: 'veh_1', role: 'insured', drivable: false, damageAreas: ['total'] }],
  ...over,
});

test('ADJUSTER-2: police report, drivability and damage areas reach the AI facts; no request-police-report action', async () => {
  put('claims', 'alpha', CLAIM_ID, theft());
  const v = await adj().getFirstView(CLAIM_ID);
  const sum = aiCalls.find((c) => c.task === 'summarize').input.facts;
  assert.deepEqual(sum.policeReport, { filed: true });
  assert.equal(sum.policeReportNumber, 'RB-1');
  assert.equal(sum.drivable, false);
  assert.deepEqual(sum.damageAreas, ['total']);
  assert.ok(!JSON.stringify(sum).includes('Example PD'), 'agency text is not sent to the model');
  assert.match(v.summary.text, /Police report: RB-1/);
  assert.ok(!v.nextActions.some((a) => /police/i.test(a.code)));
  // filed:true without a number also counts as on file
  assert.equal(hasPoliceReport({ policeReport: { filed: true } }, []), true);
  assert.equal(ruleActions({ claim: theft({ lossEvent: { cause: 'collision', policeReport: { filed: true } } }), coverage: { outcome: 'covered' } }).some((a) => a.code === 'request_police_report'), false);
});

test('ADJUSTER-2: a summary cached from an older fact set is regenerated', async () => {
  put('claims', 'alpha', CLAIM_ID, theft());
  app.ctx.forTenant('alpha').db.insert('adjuster_summaries', { claim_id: CLAIM_ID, triage_attempt: 0, doc: JSON.stringify({ text: 'No police report on file', ai: PROV }), created_at: TS });
  const v = await adj().getFirstView(CLAIM_ID);
  assert.match(v.summary.text, /Police report: RB-1/);
  assert.equal(v.summary.factsVersion, undefined, 'the cache version stays internal');
  await adj().getFirstView(CLAIM_ID);
  assert.equal(aiCalls.filter((c) => c.task === 'summarize').length, 1, 'cached once at the current version');
  assert.ok(FACTS_VERSION >= 2);
});

test('ADJUSTER-3: AI next best actions carry provider, model and confidence', async () => {
  put('claims', 'alpha', CLAIM_ID, theft());
  nbaActions = [{ code: 'REVIEW_CLAIM', label: 'Review claim details', priority: 4 }];
  const v = await adj().getFirstView(CLAIM_ID);
  const a = v.nextActions.find((x) => x.code === 'REVIEW_CLAIM');
  assert.equal(a.source, 'ai');
  assert.deepEqual(a.ai, PROV);
});

test('ADJUSTER-4: AI priority 1 is the highest; it ranks with rule high and before priority 4', () => {
  assert.equal(priorityBand(1), 'high');
  assert.equal(priorityBand(2), 'medium');
  assert.equal(priorityBand(4), 'low');
  assert.ok(priorityRank(1) > priorityRank(4));
  const merged = mergeActions(
    [{ code: 'review_subrogation', label: 'r', priority: 'medium', source: 'rule' }],
    [{ code: 'REVIEW_CLAIM', label: 'x', priority: 4 }, { code: 'CONTACT_CLAIMANT_INJURY', label: 'y', priority: 1 }, { code: 'REVIEW_SUBROGATION', label: 'dup', priority: 1 }],
    PROV,
  );
  assert.deepEqual(merged.map((a) => a.code), ['CONTACT_CLAIMANT_INJURY', 'review_subrogation', 'REVIEW_CLAIM']);
  assert.equal(merged[0].priority, 'high');
  assert.equal(merged[0].aiPriority, 1);
});

test('ADJUSTER-5: unconfirmed summary says why (carrier policy), not a confidence threshold', async () => {
  put('claims', 'alpha', CLAIM_ID, theft());
  const v = await adj().getFirstView(CLAIM_ID);
  assert.equal(v.summary.unconfirmed, true);
  assert.equal(v.summary.unconfirmedReason, 'carrier_policy');
});

test('ADJUSTER-9: Activity shows business events only, without audit duplicates, in publication order', async () => {
  put('claims', 'alpha', CLAIM_ID, theft());
  const bus = app.ctx.bus;
  bus.publish('alpha', 'claim.reported', CLAIM_ID, { claimId: CLAIM_ID, claimNumber: 'ALP-1', lob: 'personal_auto', channel: 'web', lossDate: '2026-07-13', lossCause: 'theft', reportedAt: TS });
  bus.publish('alpha', 'claim.updated', CLAIM_ID, { claimId: CLAIM_ID, version: 2 });
  bus.publish('alpha', 'claim.status.changed', CLAIM_ID, { claimId: CLAIM_ID, from: 'reported', to: 'validating', version: 2 });
  bus.publish('alpha', 'claim.status.changed', CLAIM_ID, { claimId: CLAIM_ID, from: 'validating', to: 'triaged', version: 3 });
  bus.publish('alpha', 'claim.routed', CLAIM_ID, { claimId: CLAIM_ID, decisionId: 'r', outcome: 'assigned', queue: 'auto-std', adjusterId: 'adj1', ruleIds: [] });
  await bus.drain();
  app.ctx.forTenant('alpha').audit.record({ actor: 'x', action: 'claim.status.changed', entityType: 'claim', entityId: CLAIM_ID, details: {} });
  app.ctx.forTenant('alpha').audit.record({ actor: 'x', action: 'claim.timer.started', entityType: 'claim', entityId: CLAIM_ID, details: {} });
  const v = await adj().getFirstView(CLAIM_ID);
  const types = v.timeline.map((e) => e.type);
  assert.deepEqual(types, ['claim.reported', 'claim.status.changed', 'claim.status.changed', 'claim.routed']);
  assert.ok(!v.timeline.some((e) => /^Audit|claim\.updated/.test(e.label)));
  assert.deepEqual(v.timeline[1].params, { from: 'reported', to: 'validating' });
  assert.equal(v.timeline[3].params.adjusterName, syntheticName('adj1'));
  assert.ok(!v.timeline[3].label.includes('adj1'));
});

test('ADJUSTER-10/13: inbox rows carry insuredName, assignedAt and fastTrack (no per-row browser calls needed)', async () => {
  const bus = app.ctx.bus;
  bus.publish('alpha', 'claim.reported', CLAIM_ID, { claimId: CLAIM_ID, claimNumber: 'ALP-1', lob: 'personal_auto', channel: 'web', lossDate: '2026-09-15', lossCause: 'glass', reportedAt: TS });
  bus.publish('alpha', 'claim.routed', CLAIM_ID, { claimId: CLAIM_ID, decisionId: 'r', outcome: 'fast_tracked', queue: 'auto-std', adjusterId: 'adj1', ruleIds: [] });
  bus.publish('alpha', 'claim.status.changed', CLAIM_ID, { claimId: CLAIM_ID, from: 'fast_tracked', to: 'in_review', version: 5 });
  await bus.drain();
  put('claims', 'alpha', CLAIM_ID, makeClaim({ parties: [{ id: 'pty_1', roles: ['insured'], kind: 'person', firstName: 'Zed', lastName: 'Fictional' }] }));
  put('routing', 'alpha', CLAIM_ID, { id: 'rte_1', claimId: CLAIM_ID, outcome: 'fast_tracked', queue: 'auto-std', adjusterId: 'adj1', fastTrack: true, ruleIds: [], decidedAt: '2026-09-16T10:10:00.000Z' });
  const row = (await adj().getInbox({})).items[0];
  assert.equal(row.status, 'in_review');
  assert.equal(row.insuredName, 'Zed Fictional');
  assert.equal(row.fastTrack, true);
  assert.equal(row.routingOutcome, 'fast_tracked');
  assert.equal(row.assignedAt, '2026-09-16T10:10:00.000Z');
});

test('ADJUSTER-15: a closed claim has no next best actions and makes no NBA AI call', async () => {
  put('claims', 'alpha', CLAIM_ID, theft({ status: 'closed' }));
  put('triage', 'alpha', CLAIM_ID, makeTriage(1));
  put('cov', 'alpha', CLAIM_ID, makeCoverage('not_covered'));
  const v = await adj().getFirstView(CLAIM_ID);
  assert.deepEqual(v.nextActions, []);
  assert.ok(!aiCalls.some((c) => c.task === 'next_best_actions'));
});

test('ADJUSTER-8: directory resolves adjuster ids, queue labels and rule names; route is adjuster/supervisor only', async () => {
  const d = adj().getDirectory();
  assert.equal(d.people.adj1, syntheticName('adj1'));
  assert.equal(syntheticName('adj1'), syntheticName('adj1'), 'deterministic');
  assert.notEqual(syntheticName('adj1'), 'adj1');
  assert.deepEqual(d.queues[0].label, TENANT.queues[0].label);
  assert.equal(d.rules['RT-AUTO'], 'Auto default queue');
  const tok = (roles) => app.ctx.auth.issueToken({ sub: 'u1', tenantId: 'alpha', roles });
  const call = async (roles) => (await fetch(`${app.url}/api/v1/adjuster/directory`, { headers: { authorization: `Bearer ${tok(roles)}` } }));
  assert.equal((await call(['supervisor'])).status, 200);
  assert.equal((await call(['claimant'])).status, 403);
});
