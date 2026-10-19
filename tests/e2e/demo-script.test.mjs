import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, NotImplemented, requireImplemented, runStep } from './harness.mjs';

/**
 * The 10-minute demo (docs/demo-script.md) as an API-level e2e test (S4-QE-01).
 * One shared app on port 0 with the real seed (scripts/seed.mjs) in a temp data dir. Beats run in order;
 * each beat is one subtest named "Beat N: ...". Beats use the same tenants, users and steps as the script:
 * the stage-claims.mjs script is ported to in-process fetch calls. Beat 7 (PM dashboard) is not an API beat.
 */

const A = 'aurelia-mutual';
const K = 'kestrel-point';
const WAIT_MS = 8000;
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

let app;
let dir;
let kestrelConfigBefore = null; // original Kestrel config, restored in after()
let counter = 0;
const tokens = new Map();
const staged = {}; // 'aurelia-glass' | 'kestrel-glass' | 'kestrel-rear' | 'kestrel-glass-2' -> { claim, route }

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-demo-'));
  const appOpts = { dbPath: path.join(dir, 'demo.db'), secretsDir: path.join(dir, 'secrets'), tenantsDir: path.join(ROOT, 'tenants'), logLevel: 'silent', devMode: true };
  // Real seed (npm run seed): synthetic policies per tenant and LOB, into the temp db.
  const { seed } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'seed.mjs')).href);
  const { createApp } = await import('../../src/server.mjs');
  const seeded = await seed({ createApp, appOpts, devUsersPath: path.join(dir, 'dev-users.json'), log: () => {} });
  assert.ok(seeded.seeded.length >= 4, `seed inserted policies for tenants/LOBs: ${JSON.stringify(seeded.skipped)}`);
  app = await createApp({ ...appOpts, port: 0 });
});

after(async () => {
  try {
    if (app && kestrelConfigBefore) {
      // Undo beat 4 (the script's "Reset between runs").
      const cur = await call('GET', '/config', K, 'tenant_admin');
      if (cur.status === 200 && cur.json?.fastTrack?.maxFraudScore !== kestrelConfigBefore.fastTrack.maxFraudScore) {
        const restored = { ...cur.json, fastTrack: { ...cur.json.fastTrack, maxFraudScore: kestrelConfigBefore.fastTrack.maxFraudScore } };
        await call('PUT', '/config', K, 'tenant_admin', { body: restored, ifMatch: String(cur.json.version) });
      }
    }
  } finally {
    try { if (app) await app.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

/** Dev sign-in as the demo script does: POST /auth/token with the seeded dev user for (tenant, role). */
async function token(tenantId, role) {
  const k = `${tenantId}/${role}`;
  if (!tokens.has(k)) {
    const res = await fetch(`${app.url}/api/v1/auth/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId, sub: `dev-${tenantId}-${role}`, userId: `dev-${tenantId}-${role}`, roles: [role], name: role }),
    });
    const out = await res.json().catch(() => ({}));
    assert.equal(res.status, 201, `auth/token ${k}: ${JSON.stringify(out)}`);
    tokens.set(k, out.token);
  }
  return tokens.get(k);
}

async function call(method, route, tenantId, role, { body, ifMatch, headers = {} } = {}) {
  const writes = method !== 'GET';
  const res = await fetch(`${app.url}/api/v1${route}`, {
    method,
    headers: {
      authorization: `Bearer ${await token(tenantId, role)}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(writes ? { 'idempotency-key': `demo-${process.pid}-${(counter += 1)}` } : {}),
      ...(ifMatch ? { 'if-match': ifMatch } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function waitFor(fn, what) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Ported pickPolicy: in force, effective more than 75 days ago, not expired. Keeps the fraud score at exactly 15. */
async function pickPolicy(tenantId) {
  const res = await call('GET', '/policies?q=PA-', tenantId, 'csr');
  assert.equal(res.status, 200, res.text);
  const p = res.json.items.find((x) => x.status === 'in_force' && x.period.effectiveDate <= day(75) && x.period.expirationDate > day(0));
  assert.ok(p, `${tenantId}: an in-force personal auto policy older than 75 days is seeded`);
  return p.policyNumber;
}

/** Ported report(): stage a demo claim through the public API on the csr_phone channel, then poll its routing. */
async function stage(tenantId, kind) {
  const state = tenantId === K ? 'MI' : 'WI';
  const policyNumber = await pickPolicy(tenantId);
  const snap = await call('GET', `/policies/${policyNumber}/snapshot?asOf=${day(0)}`, tenantId, 'csr');
  assert.equal(snap.status, 200, snap.text);
  const v = snap.json.vehicles[0];
  const glass = kind === 'glass';
  const created = await call('POST', '/claims', tenantId, 'csr', {
    body: {
      tenantId, lob: 'personal_auto', lossType: glass ? 'glass' : 'collision', channel: 'csr_phone', policyNumber, riskState: state,
      lossEvent: {
        lossDate: glass ? day(21) : day(2), cause: glass ? 'glass' : 'collision',
        description: glass ? 'A stone from a truck cracked the windshield on the highway. The car is drivable.'
          : 'I was stopped at a red light when the car behind me hit me hard. My neck hurts and the rear of my car is crushed.',
        location: { description: `100 Example Way, Testville, ${state}`, state }, injuriesReported: !glass, fatality: false, vehiclesInvolved: glass ? 1 : 2,
      },
      vehicles: [{ role: 'insured', policyVehicleId: v.unitId, vin: v.vin, year: v.year, make: v.make, model: v.model, drivable: glass, damageAreas: [glass ? 'glass' : 'rear'], damageDescription: glass ? 'Windshield crack' : 'Rear bumper and trunk crushed' }],
      parties: [{ roles: ['insured', 'reporter'], kind: 'person', firstName: 'Avery', lastName: 'Fenwick', phone: '(555) 010-0119' }],
    },
  });
  assert.equal(created.status, 201, created.text);
  const claim = created.json;
  // Poll instead of the script's fixed 1.2 s sleep.
  const route = await waitFor(async () => {
    const r = await call('GET', `/claims/${claim.id}/routing`, tenantId, 'adjuster');
    return r.status === 200 && r.json?.queue ? r.json : null;
  }, `routing of ${claim.claimNumber}`);
  return { claim, route };
}

const whyFastTrack = (route) => (route.reasons ?? []).filter((r) => /fast track (approved|blocked)/.test(r));

test('Beat 1: Aurelia glass claim fast tracked; Spanish self-service session', async (t) => {
  // Spanish session (Aurelia only offers it): the claimant-facing questions are served in Spanish.
  const pub = await call('GET', '/config/public', A, 'claimant');
  assert.equal(pub.status, 200, pub.text);
  assert.deepEqual(pub.json.locales, ['en', 'es']);
  const kpub = await call('GET', '/config/public', K, 'claimant');
  assert.deepEqual(kpub.json.locales, ['en'], 'the language list only appears for Aurelia');

  const es = await runStep(t, async () => {
    const s = requireImplemented(await call('POST', '/intake/sessions', A, 'claimant', { body: { lob: 'personal_auto', lossType: 'glass', channel: 'claimant_web', locale: 'es' } }), 'POST /intake/sessions');
    assert.equal(s.status, 201, s.text);
    assert.equal(s.json.locale, 'es');
    const q = s.json.question;
    assert.ok(q, 'first guided question');
    const text = typeof q.text === 'string' ? q.text : q.text?.es;
    assert.ok(text, 'first question has Spanish text');
    const en = await call('POST', '/intake/sessions', A, 'claimant', { body: { lob: 'personal_auto', lossType: 'glass', channel: 'claimant_web', locale: 'en' } });
    const enText = typeof en.json.question.text === 'string' ? en.json.question.text : en.json.question.text?.en;
    assert.notEqual(text, enText, 'Spanish question differs from English');
  });
  assert.ok(es !== undefined);

  // Policy-verified glass claim: fast tracked at Aurelia with RT-FT-GLASS and fraud 15 under the limit of 25.
  const s = await stage(A, 'glass');
  staged['aurelia-glass'] = s;
  assert.match(s.claim.claimNumber, /^AUR-/);
  assert.equal(s.route.queue, 'fast_track');
  assert.equal(s.route.fastTrack, true);
  assert.ok(whyFastTrack(s.route).some((r) => /fast track approved \(severity 5, fraud 15\)/.test(r)), JSON.stringify(s.route.reasons));
  assert.ok((s.route.reasons ?? []).concat(s.route.ruleIds ?? [], (s.route.matchedRules ?? []).map((r) => r.id ?? r)).join(' ').includes('RT-FT-GLASS'), 'rule RT-FT-GLASS applied');
});

test('Beat 2: same glass claim at Kestrel routes to a queue (fraud 15 above limit 10)', async () => {
  const s = await stage(K, 'glass');
  staged['kestrel-glass'] = s;
  assert.match(s.claim.claimNumber, /^KPT-/);
  assert.equal(s.route.queue, 'personal_auto_claims');
  assert.equal(s.route.fastTrack, false);
  assert.ok(whyFastTrack(s.route).some((r) => /fast track blocked: fraud score 15 above fast-track limit 10/.test(r)), JSON.stringify(s.route.reasons));
  // The cue the adjuster is shown: LATE_REPORT, reported 21 days after the loss.
  const triage = await call('GET', `/claims/${s.claim.id}/triage`, K, 'adjuster');
  assert.equal(triage.status, 200, triage.text);
  const signals = JSON.stringify(triage.json);
  assert.match(signals, /LATE_REPORT/);
  assert.match(signals, /21 days/);
});

test('Beat 3: Kestrel rear-end injury claim, subrogation flag, adjuster first view', async (t) => {
  const s = await stage(K, 'rear-end');
  staged['kestrel-rear'] = s;
  assert.equal(s.route.queue, 'injury');
  assert.equal(s.route.fastTrack, false);
  assert.ok((s.route.reasons ?? []).join(' ').includes('RT-INJURY-01'), JSON.stringify(s.route.reasons));

  const view = requireImplemented(await call('GET', `/claims/${s.claim.id}/triage`, K, 'adjuster'), 'GET /claims/{id}/triage');
  assert.equal(view.status, 200, view.text);
  const sub = view.json.subrogation ?? view.json.triage?.subrogation;
  assert.equal(sub?.flag, true, 'subrogation flag set at first notice');
  assert.equal(sub?.potential ?? sub?.reason ?? 'rear_ended_by_other', 'rear_ended_by_other');

  // Adjuster first view (GET /adjuster/claims/{id}/view): AI summary, next best actions, triage, routing, tasks.
  await runStep(t, async () => {
    const v = requireImplemented(await call('GET', `/adjuster/claims/${s.claim.id}/view`, K, 'adjuster'), 'GET /adjuster/claims/{id}/view');
    assert.equal(v.status, 200, v.text);
    const text = JSON.stringify(v.json);
    assert.match(text, /summary/i, 'AI summary present');
    assert.match(text, /rear_ended_by_other/, 'subrogation potential shown');
    assert.match(text, /RT-INJURY-01/, 'routing rule shown');
  });

  // The recovery task (PR-SUBRO-PA) is shown on the staged claim in the script (beat 3 step 7).
  await runStep(t, async () => {
    const tasks = requireImplemented(await call('GET', `/claims/${s.claim.id}/tasks`, K, 'adjuster'), 'GET /claims/{id}/tasks');
    assert.equal(tasks.status, 200, tasks.text);
    assert.match(JSON.stringify(tasks.json), /PR-SUBRO-PA|third-party recovery/i, 'recovery task from PR-SUBRO-PA');
  });
});

test('Beat 4: PUT /config STP threshold change flips the next Kestrel claim', async () => {
  const got = await call('GET', '/config', K, 'tenant_admin');
  assert.equal(got.status, 200, got.text);
  const before = got.json;
  kestrelConfigBefore = JSON.parse(JSON.stringify(before));
  assert.equal(before.fastTrack.maxFraudScore, 10);
  const v1 = before.version;
  assert.equal(typeof v1, 'number');

  const next = { ...before, fastTrack: { ...before.fastTrack, maxFraudScore: 20 } };
  const put = await call('PUT', '/config', K, 'tenant_admin', { body: next, ifMatch: String(v1) });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.version, v1 + 1, 'saved as the next version');
  assert.equal(put.json.fastTrack.maxFraudScore, 20);

  const s = await stage(K, 'glass');
  staged['kestrel-glass-2'] = s;
  assert.equal(s.route.queue, 'fast_track');
  assert.equal(s.route.fastTrack, true);
  assert.ok(whyFastTrack(s.route).some((r) => /fast track approved \(severity 5, fraud 15\)/.test(r)), JSON.stringify(s.route.reasons));
});

test('Beat 5: KPIs show stp_rate and acknowledgment time', async () => {
  const res = requireImplemented(await call('GET', '/kpis', K, 'tenant_admin'), 'GET /kpis');
  assert.equal(res.status, 200, res.text);
  const metrics = res.json.metrics;
  const byId = Object.fromEntries(metrics.map((m) => [m.id ?? m.key, m]));
  const stp = byId.stp_rate;
  assert.ok(stp, 'stp_rate present');
  assert.notEqual(stp.value, null, `stp_rate non-null (${stp.note ?? ''})`);
  // Script: numerator 1 after beat 4; denominator is every Kestrel claim so far (3 staged here, 4 with the live CSR claim).
  assert.equal(stp.numerator, 1, 'one Kestrel claim fast tracked (after beat 4)');
  assert.equal(stp.denominator, 3, 'every Kestrel claim so far');
  for (const id of ['subrogation_flag_rate', 'coverage_verified_at_intake_rate']) assert.ok(byId[id], `${id} present`);
  const a = await call('GET', '/kpis', A, 'tenant_admin');
  assert.equal(a.status, 200, a.text);
  const aById = Object.fromEntries(a.json.metrics.map((m) => [m.id ?? m.key, m]));
  assert.ok(aById.spanish_session_share && aById.digital_self_service_share, 'Aurelia has VD-6 metrics');

  // Acknowledgment time (VD-2, REQ-12): claims auto-acknowledge on claim.reported, which meets the acknowledge timer.
  const ack = metrics.filter((m) => /acknowledg/.test(m.id ?? m.key ?? ''));
  assert.ok(ack.length > 0, `an acknowledgment-time metric exists: ${metrics.map((m) => m.id ?? m.key).join(', ')}`);
  const ackValue = (await waitFor(async () => {
    const r = await call('GET', '/kpis', K, 'tenant_admin');
    const m = (r.json?.metrics ?? []).find((x) => /acknowledg/.test(x.id ?? x.key ?? ''));
    return m && m.value !== null && m.value !== undefined ? { value: m.value } : null; // 0 minutes is a valid value
  }, 'acknowledgment time is non-null after the demo flow')).value;
  assert.ok(Number.isFinite(Number(ackValue)), `acknowledgment time is a number (${ackValue})`);
});

test('Beat 6: webhook outbox event and core adapter payload differ per tenant', async () => {
  const sub = await call('POST', '/integrations/webhooks', K, 'carrier_admin', {
    body: { url: 'https://events.kestrel-point.example/hooks/claims', eventTypes: ['claim.reported', 'claim.routed'] },
  });
  assert.equal(sub.status, 201, sub.text);
  assert.ok(sub.json.secret || sub.json.signingSecret || sub.json.id, 'subscription created (secret shown once)');

  const kid = staged['kestrel-glass-2'].claim.id;
  const aid = staged['aurelia-glass'].claim.id;
  const routed = async (tenantId, role, id) => waitFor(async () => {
    const r = await call('GET', `/integrations/outbox?type=claim.routed&subject=${id}`, tenantId, role);
    return r.status === 200 && r.json.items?.length ? r.json.items[0] : null;
  }, `claim.routed in ${tenantId} outbox`);
  const kEv = (await routed(K, 'carrier_admin', kid)).event;
  const aEv = (await routed(A, 'carrier_admin', aid)).event;
  const ev = typeof kEv === 'string' ? JSON.parse(kEv) : kEv;
  assert.equal(ev.type, 'claim.routed');
  assert.ok(!/Fenwick|555/.test(JSON.stringify(ev)), 'events carry ids and codes, no personal data');
  assert.notEqual(ev.tenantId ?? ev.data?.tenantId, (typeof aEv === 'string' ? JSON.parse(aEv) : aEv).tenantId ?? undefined);

  const adapters = await call('GET', '/integrations/adapters', K, 'carrier_admin');
  assert.equal(adapters.status, 200, adapters.text);
  assert.ok(adapters.json.items.some((x) => x.id === 'core-claims-suite'), 'core-claims-suite registered');

  const kp = await call('GET', `/integrations/adapters/core-claims-suite/preview/${kid}`, K, 'carrier_admin');
  const ap = await call('GET', `/integrations/adapters/core-claims-suite/preview/${aid}`, A, 'carrier_admin');
  assert.equal(kp.status, 200, kp.text);
  assert.equal(ap.status, 200, ap.text);
  assert.equal(kp.json.adapterId, 'core-claims-suite');
  assert.ok(kp.json.payload && ap.json.payload, 'payloads present');
  assert.notDeepEqual(kp.json.payload, ap.json.payload, 'payloads differ per tenant');
  const [ks, as] = [JSON.stringify(kp.json.payload), JSON.stringify(ap.json.payload)];
  assert.ok(ks.includes(staged['kestrel-glass-2'].claim.claimNumber) || ks.includes(kid), 'Kestrel payload carries its claim');
  assert.ok(as.includes(staged['aurelia-glass'].claim.claimNumber) || as.includes(aid), 'Aurelia payload carries its claim');
  assert.ok(!ks.includes('AUR-') && !as.includes('KPT-'), 'no cross-tenant leakage');
});
