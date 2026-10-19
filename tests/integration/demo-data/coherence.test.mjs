// S6-BUG-05: the seeded demo tells one coherent story. Runs seed + demo-data into a temporary database and checks the
// defects found in bug-bash round 1 (DATA-1/7/9/11/12/13, ADJUSTER-11/12/19, CSR-4/9/22, ADMIN-12, CLAIMANT-1/7).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../../src/server.mjs';
import { seed, defaultDevUsersPath } from '../../../scripts/seed.mjs';
import { demoData, demoAdjuster, demoAgent } from '../../../scripts/demo-data.mjs';

const DAY = 86400000;
const quiet = () => {};
let dir;
let app;
const factory = (o) => createApp({ ...o, dbPath: path.join(dir, 'fnol.db'), secretsDir: path.join(dir, 'secrets'), logLevel: 'silent', devMode: true });
const NOW = Date.parse('2026-10-19T20:00:00Z');
const T = ['aurelia-mutual', 'kestrel-point'];
const state = {};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-s6-demo-'));
  await seed({ createApp: factory, log: quiet, devUsersPath: path.join(dir, 'dev-users.json') });
  const r = await demoData({ createApp: factory, log: quiet, now: NOW });
  assert.equal(r.failed, 0, JSON.stringify(r.failures));
  app = await factory({ port: 0 });
  for (const t of T) {
    const tctx = app.ctx.forTenant(t);
    const m = tctx.modules;
    const { items } = await m.claims.listClaims({}, { limit: 200 });
    const rows = [];
    for (const c of items) {
      const full = await m.claims.getClaim(c.id, { include: ['parties'] });
      const snap = await m.coverage.getPolicySnapshot({ policyNumber: c.policyNumber, asOf: full.lossEvent.lossDate });
      rows.push({ claim: full, snap, triage: await m.triage.getLatestTriage(c.id), notes: await m.claims.listNotes(c.id) });
    }
    state[t] = { rows, tctx };
  }
});
after(async () => { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('DATA-1 / ADJUSTER-12: every claim names the policy named insured as its insured party', () => {
  for (const t of T) {
    for (const { claim, snap } of state[t].rows) {
      const ins = claim.parties.find((p) => p.roles.includes('insured'));
      assert.ok(ins, `${claim.claimNumber} has an insured party`);
      const name = ins.organizationName ?? `${ins.firstName} ${ins.lastName}`;
      assert.equal(name, snap.namedInsureds[0].name, claim.claimNumber);
      if (claim.lob === 'commercial_auto') assert.equal(ins.kind, 'organization');
    }
  }
});

test('DATA-7 / ADJUSTER-11 / CSR-22: claims are reported days after the loss, spread over recent weeks', () => {
  for (const t of T) {
    const rows = state[t].rows;
    const reported = rows.map((r) => Date.parse(r.claim.reportedAt));
    assert.equal(new Set(reported).size, rows.length, 'distinct report times');
    assert.ok(Math.max(...reported) - Math.min(...reported) > 14 * DAY, 'spread over more than two weeks');
    assert.ok(Math.max(...reported) < NOW, 'nothing in the future');
    for (const { claim, triage } of rows) {
      const days = Math.round((Date.parse(claim.reportedAt.slice(0, 10)) - Date.parse(claim.lossEvent.lossDate)) / DAY);
      const late = (triage?.fraud?.indicators ?? []).some((i) => i.code === 'LATE_REPORT');
      if (claim.lossType === 'theft') { assert.equal(days, 12, 'the deliberate late-report theft'); assert.ok(late); }
      else { assert.ok(days >= 0 && days <= 8, `${claim.claimNumber}: ${days} days`); assert.ok(!late, `${claim.claimNumber} has no late-report flag`); }
    }
  }
});

test('DATA-9 / ADJUSTER-19: the demo adjuster owns a varied caseload', () => {
  for (const t of T) {
    const senior = demoAdjuster(app.ctx.tenants.get(t));
    const open = state[t].rows.filter((r) => r.claim.routing?.adjusterId === senior && !['closed', 'withdrawn'].includes(r.claim.status));
    assert.ok(open.length >= 4, `${t} ${senior} owns ${open.length}`);
    assert.ok(new Set(open.map((r) => r.claim.lob)).size >= 2, 'more than one line of business');
    assert.ok(new Set(open.map((r) => r.triage?.severityBand)).size >= 2, 'more than one severity band');
  }
});

test('DATA-11: notes are written by the assigned adjuster, a persona, or the fast-track system', () => {
  for (const t of T) {
    for (const { claim, notes } of state[t].rows) {
      for (const n of notes) {
        const id = n.author?.id;
        assert.ok(id === claim.routing?.adjusterId || id === 'fast-track' || id === `dev-${t}-supervisor` || id === `dev-${t}-adjuster`, `${claim.claimNumber} note by ${id}`);
      }
    }
  }
});

test('DATA-13 / ADMIN-12: channel and locale mix behind the KPIs', async () => {
  for (const t of T) {
    const channels = new Set(state[t].rows.map((r) => r.claim.channel));
    assert.ok(channels.has('claimant_web'), `${t}: ${[...channels]}`);
    assert.ok(channels.has('csr_phone'));
    const k = await state[t].tctx.modules.kpi.compute({ from: new Date(NOW - 60 * DAY).toISOString(), to: new Date(NOW).toISOString() });
    const v = Object.fromEntries(k.metrics.map((m) => [m.id, m.value]));
    assert.ok(v.median_minutes_to_acknowledgment > 0, JSON.stringify(v));
    assert.ok(v.median_minutes_to_assignment > v.median_minutes_to_acknowledgment);
    assert.ok(v.digital_self_service_share > 0);
    assert.ok(v.automated_capture_rate > 0);
    assert.ok(v.stp_rate > 0);
  }
  assert.ok(state['aurelia-mutual'].rows.some((r) => r.claim.channel === 'agent_portal'));
  const k = await state['aurelia-mutual'].tctx.modules.kpi.compute({ from: new Date(NOW - 60 * DAY).toISOString(), to: new Date(NOW).toISOString() });
  assert.ok(k.metrics.find((m) => m.id === 'spanish_session_share').value > 0, 'Aurelia (en/es) has Spanish sessions');
});

test('CSR-4 / CSR-9 / DATA-12: seeded policies carry phones, varied ZIPs and the demo agent as producer', async () => {
  for (const t of T) {
    const cov = state[t].tctx.modules.coverage;
    const produced = await cov.producedPolicyNumbers(demoAgent(t).agentId);
    assert.ok(produced.length >= 5, `${t} agent produces ${produced.length}`);
    const { items, total } = await cov.searchByQuery('PA-');
    assert.ok(total >= 25);
    assert.ok(items.every((p) => /^\*\*\*-\*\*\*-01\d\d$/.test(p.contact.phone)), 'every summary has a masked phone');
    const zips = new Set(items.map((p) => p.contact.postalCode));
    assert.ok(zips.size >= 3, `varied ZIP prefixes: ${[...zips]}`);
    const phoneHit = await cov.searchByQuery(state[t].rows[0].claim.parties.find((p) => p.roles.includes('insured')).phone);
    assert.equal(phoneHit.kind, 'phone');
    assert.ok(phoneHit.items.length > 0, 'phone search finds the insured');
  }
});

test('DATA-18: seed writes dev users next to a temporary database, not into the repo', () => {
  assert.equal(defaultDevUsersPath({ FNOL_DB_PATH: '/tmp/x/fnol.db' }), '/tmp/x/dev-users.json');
  assert.equal(defaultDevUsersPath({ FNOL_DEV_USERS_PATH: '/tmp/u.json', FNOL_DB_PATH: '/tmp/x/fnol.db' }), '/tmp/u.json');
  assert.match(defaultDevUsersPath({}), /data[\\/]dev-users\.json$/);
  assert.ok(fs.existsSync(path.join(dir, 'dev-users.json')));
});

test('ADJUSTER-18: major and severe claims are not low complexity', () => {
  for (const t of T) {
    for (const { claim, triage } of state[t].rows) {
      if (['major', 'severe'].includes(triage?.severityBand)) assert.notEqual(triage.complexity, 'low', claim.claimNumber);
    }
  }
});
