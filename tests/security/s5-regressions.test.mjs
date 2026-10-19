// S5-SEC-01: Sprint 5 regression tests, written by the security reviewer against the code at HEAD.
// Covers the policy-vehicles holder oracle (S5-WFL-01/04/05), unsafe tenant regexes rejected at save (SEC2-014 / SEC3-003),
// labelled-name redaction before cloud calls (S5-AI-08, SEC2-011) and the X-Fnol-Authorization header (S5-EXP-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policies } from '../../src/modules/coverage/fixtures.mjs';
import { redactValue, restore } from '../../src/ai/guardrails.mjs';
import { bootReal, call, T1, T2 } from './sec2-helpers.mjs';

const BASE = '/api/v1/intake/sessions';
const POLICY = 'AUT-100001'; // holder "Avery Testwell", garaging ZIP 60601 (synthetic fixture)
const T2_ONLY = 'AUT-T2ONLY1';
const GOOD = 'lastName=Testwell&zip=60601';
const wrong = (i) => `lastName=Testwell&zip=${String(10000 + i)}`;

/** Boot with the policy fixtures seeded in T1 and one extra policy that exists only in T2. */
async function bootHolder() {
  const app = await bootReal();
  await app.ctx.forTenant(T1).modules.coverage.seedPolicies(policies);
  const base = policies.find((p) => p.policyNumber === POLICY);
  await app.ctx.forTenant(T2).modules.coverage.seedPolicies([{ ...structuredClone(base), policyNumber: T2_ONLY }]);
  return app;
}
const claimantToken = (app, tenant, sub) => app.as(tenant, ['claimant'], sub);
const CHANNEL = { [T1]: 'claimant_web', [T2]: 'api' }; // kestrel-point enables csr_phone and api only
const start = async (app, token, policyNumber = POLICY, tenant = T1) => {
  const r = await call(app, 'POST', BASE, { token, body: { lob: 'personal_auto', channel: CHANNEL[tenant], policyNumber } });
  assert.equal(r.status, 201, r.text.slice(0, 200));
  return r.json.sessionId;
};
const vehicles = (app, token, sid, q) => call(app, 'GET', `${BASE}/${sid}/policy-vehicles?${q}`, { token });
const lockoutRows = (app) => app.ctx.db.raw.prepare('SELECT * FROM intake_holder_lockouts').all();

// ---- policy-vehicles oracle (S5-WFL-01 / S5-WFL-04) -----------------------------------------------------

test('S5-WFL-04: the claimant policy-vehicles check gives one uniform 404 for every failure mode', async () => {
  const app = await bootHolder();
  try {
    const tok = claimantToken(app, T1, 'oracle-claimant');
    const ok = await vehicles(app, tok, await start(app, tok), GOOD);
    assert.equal(ok.status, 200, 'precondition: the true holder is verified');
    const failures = {
      wrongLastName: await vehicles(app, tok, await start(app, tok), 'lastName=Nobody&zip=60601'),
      firstNameOnly: await vehicles(app, tok, await start(app, tok), 'lastName=Avery&zip=60601'),
      wrongZip: await vehicles(app, tok, await start(app, tok), 'lastName=Testwell&zip=99999'),
      missingZip: await vehicles(app, tok, await start(app, tok), 'lastName=Testwell'),
      missingName: await vehicles(app, tok, await start(app, tok), 'zip=60601'),
      noQuery: await vehicles(app, tok, await start(app, tok), ''),
      unknownPolicy: await vehicles(app, tok, await start(app, tok, 'AUT-NOSUCH99'), GOOD),
      otherTenantPolicy: await vehicles(app, tok, await start(app, tok, T2_ONLY), GOOD),
    };
    for (const [name, r] of Object.entries(failures)) {
      assert.equal(r.status, 404, `${name} gave ${r.status}`);
      assert.deepEqual(r.json, failures.unknownPolicy.json, `${name} body differs from the unknown-policy body`);
      assert.equal(r.text, failures.unknownPolicy.text, `${name} raw body differs`);
    }
  } finally { await app.close(); }
});

test('S5-WFL-04: the vehicle list for a verified holder exposes only unitId, year, make, model and vinLast4', async () => {
  const app = await bootHolder();
  try {
    const tok = claimantToken(app, T1, 'oracle-claimant');
    const r = await vehicles(app, tok, await start(app, tok), GOOD);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json) && r.json.length > 0);
    const allowed = new Set(['unitId', 'year', 'make', 'model', 'vinLast4']);
    for (const v of r.json) for (const k of Object.keys(v)) assert.ok(allowed.has(k), `unexpected field ${k}`);
    assert.ok(!r.text.includes('1FNOL00000A100001'), 'full VIN returned');
    assert.ok(!r.text.includes('Avery') && !r.text.includes('Testwell') && !r.text.includes('60601'), 'holder name or ZIP echoed');
  } finally { await app.close(); }
});

test('S5-WFL-04: a claimant token cannot use another claimant\'s session (uniform 404) and tokens need no name claim', async () => {
  const app = await bootHolder();
  try {
    const a = claimantToken(app, T1, 'claimant-a');
    const b = claimantToken(app, T1, 'claimant-b');
    const sid = await start(app, a);
    const r = await vehicles(app, b, sid, GOOD);
    assert.equal(r.status, 404);
    const gone = await vehicles(app, b, 'isn_doesnotexist', GOOD);
    assert.equal(gone.status, 404);
    assert.deepEqual(r.json, gone.json, 'session ownership is distinguishable from a missing session');
  } finally { await app.close(); }
});

test('S5-WFL-04: five failures on a session lock that session even for the correct answer', async () => {
  const app = await bootHolder();
  try {
    const tok = claimantToken(app, T1, 'oracle-claimant');
    const sid = await start(app, tok);
    for (let i = 0; i < 5; i += 1) assert.equal((await vehicles(app, tok, sid, wrong(i))).status, 404);
    assert.equal((await vehicles(app, tok, sid, GOOD)).status, 404, 'session unlocked after 5 failures');
    assert.equal((await vehicles(app, tok, await start(app, tok), GOOD)).status, 200, 'a fresh session for the same user still works below the policy limit');
  } finally { await app.close(); }
});

// ---- per-policy lockout (S5-WFL-05) ----------------------------------------------------------------------

test('S5-WFL-05: failures count per (tenant, policy) across new sessions and new users, so ZIP guessing is capped', async () => {
  const app = await bootHolder();
  try {
    for (let i = 0; i < 10; i += 1) {
      const tok = claimantToken(app, T1, `guesser-${i}`); // a new identity and session every time
      assert.equal((await vehicles(app, tok, await start(app, tok), wrong(i))).status, 404);
    }
    const victim = claimantToken(app, T1, 'real-holder');
    const locked = await vehicles(app, victim, await start(app, victim), GOOD);
    assert.equal(locked.status, 404, 'the correct answer was accepted after 10 failures on the policy');
    const unknown = await vehicles(app, victim, await start(app, victim, 'AUT-NOSUCH99'), GOOD);
    assert.equal(locked.text, unknown.text, 'a locked policy is distinguishable from an unknown one');
  } finally { await app.close(); }
});

test('S5-WFL-05: 20 parallel wrong guesses across sessions are all counted and the lock holds', async () => {
  const app = await bootHolder();
  try {
    const sids = [];
    for (let i = 0; i < 20; i += 1) { const tok = claimantToken(app, T1, `par-${i}`); sids.push([tok, await start(app, tok)]); }
    const rs = await Promise.all(sids.map(([tok, sid], i) => vehicles(app, tok, sid, wrong(i))));
    assert.ok(rs.every((r) => r.status === 404));
    const rows = lockoutRows(app).filter((r) => r.tenant_id === T1);
    assert.equal(rows.length, 1, 'one counter row per (tenant, policy)');
    assert.ok(rows[0].failures >= 20, `only ${rows[0].failures} of 20 parallel failures were recorded`);
    const victim = claimantToken(app, T1, 'real-holder');
    assert.equal((await vehicles(app, victim, await start(app, victim), GOOD)).status, 404);
  } finally { await app.close(); }
});

test('S5-WFL-05: 20 parallel wrong guesses on ONE session are all counted', async () => {
  const app = await bootHolder();
  try {
    const tok = claimantToken(app, T1, 'par-one');
    const sid = await start(app, tok);
    await Promise.all(Array.from({ length: 20 }, (_, i) => vehicles(app, tok, sid, wrong(i))));
    const rows = lockoutRows(app).filter((r) => r.tenant_id === T1);
    assert.ok(rows[0].failures >= 20, `only ${rows[0].failures} of 20 were recorded`);
  } finally { await app.close(); }
});

test('S5-WFL-05: the counter is keyed (no plain policy number), tenant-scoped, and a lock in one tenant does not touch another', async () => {
  const app = await bootHolder();
  try {
    // Same policy number in both tenants (holder data differs by tenant only through the seed; use the same fixture).
    await app.ctx.forTenant(T2).modules.coverage.seedPolicies(policies);
    for (let i = 0; i < 11; i += 1) { const tok = claimantToken(app, T1, `lock-${i}`); await vehicles(app, tok, await start(app, tok), wrong(i)); }
    const t1 = claimantToken(app, T1, 'h1');
    assert.equal((await vehicles(app, t1, await start(app, t1), GOOD)).status, 404, 'T1 policy should be locked');
    const t2 = claimantToken(app, T2, 'h2');
    assert.equal((await vehicles(app, t2, await start(app, t2, POLICY, T2), GOOD)).status, 200, 'a T1 lock leaked into T2');
    const rows = lockoutRows(app);
    assert.ok(!JSON.stringify(rows).includes(POLICY), 'policy number stored in plain text');
    const byTenant = Object.fromEntries(rows.map((r) => [r.tenant_id, r.failures]));
    assert.ok(byTenant[T1] >= 11, `T1 failures ${byTenant[T1]}`);
    assert.ok((byTenant[T2] ?? 0) <= 1, `T2 counter polluted by T1 attempts: ${byTenant[T2]}`);
  } finally { await app.close(); }
});

test('S5-WFL-05: csr and agent rules are unchanged by the claimant lockout', async () => {
  const app = await bootHolder();
  try {
    for (let i = 0; i < 11; i += 1) { const tok = claimantToken(app, T1, `lock-${i}`); await vehicles(app, tok, await start(app, tok), wrong(i)); }
    const csr = app.as(T1, ['csr'], 'csr-1');
    const sid = await start(app, csr);
    const r = await vehicles(app, csr, sid, '');
    assert.equal(r.status, 200, 'csr must not be locked out by claimant guessing');
    assert.ok(r.json.length > 0);
    // an agent that does not produce the policy still gets the uniform 404
    const agent = app.as(T1, ['agent'], 'agent-not-producer');
    const asAgent = await call(app, 'POST', BASE, { token: agent, body: { lob: 'personal_auto', channel: 'agent_portal', policyNumber: POLICY } });
    if (asAgent.status === 201) assert.equal((await vehicles(app, agent, asAgent.json.sessionId, '')).status, 404);
    else assert.ok([403, 404].includes(asAgent.status));
  } finally { await app.close(); }
});

// ---- unsafe tenant regex rejected at save (SEC2-014 / SEC3-003 / SEC2-013) ------------------------------------

const UNSAFE = ['^(a+)+$', '(a|aa)+$', '^a*a*a*a*a*a*b', '.*.*.*.*.*x', '(a?){30}a{30}', '(\\w|\\d)+x$'];

test('SEC2-014 / SEC3-003: a tenant question pattern that can backtrack is rejected at save with 422', async () => {
  const app = await bootReal();
  try {
    const adm = app.as(T1, ['tenant_admin'], 'adm');
    const g = await call(app, 'GET', '/api/v1/config', { token: adm });
    assert.equal(g.status, 200);
    for (const bad of UNSAFE) {
      const cfg = structuredClone(g.json);
      const q = cfg.questionSets[0].questions[0];
      q.validation = { ...(q.validation ?? {}), pattern: bad };
      const res = await fetch(app.url + '/api/v1/config', {
        method: 'PUT', headers: { authorization: `Bearer ${adm}`, 'content-type': 'application/json', 'if-match': `"${g.json.version}"` }, body: JSON.stringify(cfg),
      });
      const body = await res.json();
      assert.equal(res.status, 422, `unsafe pattern ${bad} was saved (${res.status})`);
      assert.ok(body.errors.some((e) => e.code === 'unsafe_pattern'), `no unsafe_pattern error for ${bad}`);
    }
    const after = await call(app, 'GET', '/api/v1/config', { token: adm });
    assert.equal(after.json.version, g.json.version, 'a rejected save changed the stored config version');
  } finally { await app.close(); }
});

test('SEC2-013: the shared checker rejects ambiguous and polynomial patterns and still accepts ordinary formats', async () => {
  const { isSafePattern } = await import('../../src/core/safe-pattern.mjs');
  for (const p of [...UNSAFE, '(a|a)*b', '(.*a){20}', '(a*)*b', '(?=a)a', '(a)\\1', 'a'.repeat(201)]) assert.equal(isSafePattern(p), false, `${p} accepted`);
  for (const p of ['^[A-Z]{2}\\d{6}$', '^\\d{5}(-\\d{4})?$', '^[A-Za-z0-9-]{3,20}$']) assert.equal(isSafePattern(p), true, `${p} rejected`);
});

test('SEC3-003: a rule condition with an unsafe "matches" regex is rejected by the config validator', async () => {
  const app = await bootReal();
  try {
    const adm = app.as(T1, ['tenant_admin'], 'adm');
    const g = await call(app, 'GET', '/api/v1/config', { token: adm });
    const cfg = structuredClone(g.json);
    cfg.questionSets[0].questions[0].showIf = { op: 'matches', fact: 'answers.loss_description', value: '(a|aa)+$' };
    const v = await call(app, 'POST', '/api/v1/config/validate', { token: adm, body: cfg });
    assert.equal(v.status, 200);
    assert.equal(v.json.valid, false);
    assert.ok(v.json.errors.some((e) => e.code === 'unsafe_pattern'), `no error for the unsafe matches value: ${JSON.stringify(v.json.errors).slice(0, 300)}`);
  } finally { await app.close(); }
});

// ---- labelled-name redaction (S5-AI-08, SEC2-011) -------------------------------------------------------------

test('S5-AI-08: labelled person names are redacted before a cloud provider and restored in the result', async () => {
  const app = await bootReal();
  try {
    const seen = [];
    const cloud = {
      async available() { return true; },
      async run(task, input) { seen.push(JSON.stringify(input)); return { output: { summary: 'ok', bullets: [] }, confidence: 0.95, explanation: 'x' }; },
    };
    const text = 'Customer: Morgan Ellis, phone 555-010-4410. Insured: Quincy Fairweather\nWitness: Ola Brandt. Repair Shop: Maple Street Auto';
    // The seed tenant cascade is local first, then vertex-claude for summarize: a low-confidence local answer escalates to the cloud tier.
    const weakLocal = { async available() { return true; }, async run() { return { output: { summary: 'x', bullets: [] }, confidence: 0.05, explanation: 'weak' }; } };
    const r = await app.ctx.forTenant(T1).ai.run('summarize', { text }, { claimId: 'clm_sec5', providers: { local: weakLocal, 'vertex-claude': cloud } });
    assert.equal(r.provider, 'vertex-claude', 'precondition: the cloud tier was used');
    const sent = seen[0];
    assert.ok(sent, 'cloud provider was not called');
    for (const leaked of ['Morgan', 'Ellis', 'Quincy', 'Fairweather', 'Ola', 'Brandt', '555-010-4410']) assert.ok(!sent.includes(leaked), `cloud provider received "${leaked}"`);
    assert.ok(sent.includes('Maple Street Auto'), 'fixed vocabulary (shop name) was over-redacted');
  } finally { await app.close(); }
});

test('S5-AI-08: every golden-set PII string is absent from the redacted input and redaction round-trips', async () => {
  const fs = await import('node:fs');
  const dir = new URL('../fixtures/ai/golden/', import.meta.url);
  let checked = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    for (const c of JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')).cases) {
      const r = redactValue(c.input);
      const out = JSON.stringify(r.value);
      for (const p of c.pii ?? []) { assert.ok(!out.includes(p), `${f}/${c.id} leaks ${p}`); checked += 1; }
      assert.deepEqual(restore(r.value, r.map), c.input, `${f}/${c.id} does not restore`);
    }
  }
  assert.ok(checked > 10, `only ${checked} PII strings were checked`);
});

test('S5-AI-08: redaction of a 50k-character hostile input is linear (under 100 ms)', () => {
  for (const text of ['Customer: '.repeat(5000), `Customer: ${'Aa '.repeat(16000)}`, 'Name '.repeat(10000), `Insured ${'A'.repeat(50000)}`]) {
    const t0 = performance.now();
    redactValue({ text: text.slice(0, 50000) });
    const ms = performance.now() - t0;
    assert.ok(ms < 100, `redaction took ${Math.round(ms)} ms`);
  }
});

// ---- X-Fnol-Authorization (S5-EXP-01) -------------------------------------------------------------------------

test('S5-EXP-01: the app token is accepted in Authorization or X-Fnol-Authorization, with the same checks', async () => {
  const app = await bootReal();
  try {
    const good = app.as(T1, ['supervisor'], 'sup');
    const viaAuth = await call(app, 'GET', '/api/v1/audit', { token: good });
    const viaFnol = await call(app, 'GET', '/api/v1/audit', { headers: { 'x-fnol-authorization': `Bearer ${good}` } });
    assert.equal(viaAuth.status, 200);
    assert.equal(viaFnol.status, 200);
    // roles are enforced the same way through the alternate header
    const claimant = app.as(T1, ['claimant'], 'c');
    const denied = await call(app, 'GET', '/api/v1/audit', { headers: { 'x-fnol-authorization': `Bearer ${claimant}` } });
    assert.equal(denied.status, 403);
    // tenant binding: a tenant-1 token still cannot read tenant-2 data through the alternate header
    const xt = await call(app, 'GET', '/api/v1/audit', { headers: { 'x-fnol-authorization': `Bearer ${good}`, 'x-tenant-id': T2 } });
    assert.equal(xt.status, 403, 'X-Tenant-Id override honoured for a non platform_admin token via X-Fnol-Authorization');
  } finally { await app.close(); }
});

test('S5-EXP-01: bad, tampered, expired-looking and malformed tokens are rejected in either header', async () => {
  const app = await bootReal();
  try {
    const good = app.as(T1, ['supervisor'], 'sup');
    const [h, p, s] = good.split('.');
    const flipped = `${h}.${p}.${s.slice(0, -2)}${s.endsWith('A') ? 'B' : 'A'}${s.slice(-1)}`;
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), roles: ['platform_admin'] })).toString('base64url');
    const bads = ['garbage', '', flipped, `${h}.${forgedPayload}.${s}`, `${h}.${p}`, 'null'];
    for (const header of ['authorization', 'x-fnol-authorization']) {
      for (const bad of bads) {
        const r = await call(app, 'GET', '/api/v1/audit', { headers: { [header]: `Bearer ${bad}` } });
        assert.equal(r.status, 401, `${header}: Bearer ${bad.slice(0, 20)} gave ${r.status}`);
      }
      const noScheme = await call(app, 'GET', '/api/v1/audit', { headers: { [header]: good } });
      assert.equal(noScheme.status, 401, `${header} without the Bearer scheme was accepted`);
    }
    // Authorization wins when both are present: a good alternate header does not rescue a bad primary one.
    const both = await call(app, 'GET', '/api/v1/audit', { token: 'garbage', headers: { 'x-fnol-authorization': `Bearer ${good}` } });
    assert.equal(both.status, 401);
    const none = await call(app, 'GET', '/api/v1/audit');
    assert.equal(none.status, 401);
  } finally { await app.close(); }
});

test('S5-EXP-01: /runtime-config.js exposes only the devMode flag and is not cacheable', async () => {
  const app = await bootReal();
  try {
    const res = await fetch(`${app.url}/runtime-config.js`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/i);
    assert.match(text, /__FNOL_DEV__/);
    assert.ok(!/secret|token|key|password/i.test(text.replace(/__FNOL_DEV__/g, '')), `runtime-config leaks more than the flag: ${text.slice(0, 200)}`);
    assert.equal(text.replace(/\s+/g, '').length < 200, true);
  } finally { await app.close(); }
});

// ---- Sprint 3 gate findings re-verified end to end (SEC3-001, 002, 004, 005, 006) ----------------------------

/** Answer every question of a claimant intake session with generic valid values and return the session id. */
async function completeSession(app, token, desc = 'Rear-ended at a red light') {
  const r = await call(app, 'POST', BASE, { token, body: { lob: 'personal_auto', lossType: 'collision', channel: 'claimant_web', locale: 'en', policyNumber: POLICY } });
  assert.equal(r.status, 201, r.text.slice(0, 200));
  const sid = r.json.sessionId;
  for (let i = 0; i < 40; i += 1) {
    const n = await call(app, 'GET', `${BASE}/${sid}/next-question`, { token });
    const q = n.json.question;
    if (!q) break;
    const byType = { date: '2026-10-01', boolean: false, select: q.options?.[0]?.value, disclosure: true, longtext: desc, text: desc };
    assert.ok(q.type in byType, `cannot answer question type ${q.type} (${q.id})`);
    const a = await call(app, 'POST', `${BASE}/${sid}/answers`, { token, body: { questionId: q.id, value: byType[q.type] } });
    assert.equal(a.status, 200, `answer ${q.id}: ${a.text.slice(0, 200)}`);
  }
  return sid;
}

test('SEC3-001: a claimant submit (first call and replay) returns only {id, claimNumber, status}', async () => {
  const app = await bootHolder();
  try {
    const tok = claimantToken(app, T1, 'sub-claimant');
    const sid = await completeSession(app, tok);
    const first = await call(app, 'POST', `${BASE}/${sid}/submit`, { token: tok });
    assert.equal(first.status, 201, first.text.slice(0, 300));
    assert.deepEqual(Object.keys(first.json).sort(), ['claimNumber', 'id', 'status']);
    await app.ctx.bus.drain();
    const replay = await call(app, 'POST', `${BASE}/${sid}/submit`, { token: tok });
    assert.ok([200, 201].includes(replay.status), `replay gave ${replay.status}`);
    assert.deepEqual(Object.keys(replay.json).sort(), ['claimNumber', 'id', 'status']);
    for (const leak of ['triage', 'fraud', 'siu', 'routing', 'severity', 'parties', 'vehicles']) assert.ok(!replay.text.includes(leak), `replay body mentions ${leak}`);
    assert.equal(replay.json.id, first.json.id);
  } finally { await app.close(); }
});

test('SEC3-002: a client Idempotency-Key cannot address another session\'s claim', async () => {
  const app = await bootHolder();
  try {
    const victim = claimantToken(app, T1, 'victim');
    const attacker = claimantToken(app, T1, 'attacker');
    const vs = await completeSession(app, victim, 'Victim loss description');
    const as = await completeSession(app, attacker, 'Attacker loss description');
    const key = 'predictable-key-001';
    const v = await call(app, 'POST', `${BASE}/${vs}/submit`, { token: victim, headers: { 'idempotency-key': key } });
    assert.equal(v.status, 201, v.text.slice(0, 300));
    const a = await call(app, 'POST', `${BASE}/${as}/submit`, { token: attacker, headers: { 'idempotency-key': key } });
    assert.equal(a.status, 201, a.text.slice(0, 300));
    assert.notEqual(a.json.id, v.json.id, 'the attacker\'s submit with the victim\'s key returned the victim\'s claim');
    assert.notEqual(a.json.claimNumber, v.json.claimNumber);
    // the attacker's session is bound to the attacker's own new claim
    const own = await call(app, 'GET', `/api/v1/claims/${a.json.id}`, { token: attacker });
    assert.equal(own.status, 200);
    const theirs = await call(app, 'GET', `/api/v1/claims/${v.json.id}`, { token: attacker });
    assert.equal(theirs.status, 404);
    // malformed keys are rejected
    const s3 = await completeSession(app, attacker);
    const bad = await call(app, 'POST', `${BASE}/${s3}/submit`, { token: attacker, headers: { 'idempotency-key': 'x'.repeat(300) } });
    assert.equal(bad.status, 400);
  } finally { await app.close(); }
});

test('SEC3-004: narrative suggestions are not stored in plaintext in the database and still round-trip', async () => {
  const { dumpText } = await import('./helpers.mjs');
  const app = await bootHolder();
  try {
    const csr = app.as(T1, ['csr'], 'csr-narr');
    const s = await call(app, 'POST', BASE, { token: csr, body: { lob: 'personal_auto', channel: 'csr_phone' } });
    const marker = 'Zzyzx-Narrative-Marker whiplash and neck pain';
    const n = await call(app, 'POST', `${BASE}/${s.json.sessionId}/narrative`, { token: csr, body: { text: `I was hit by Marlon Zzyzx. ${marker}` } });
    assert.equal(n.status, 200);
    const dump = dumpText(app);
    assert.ok(!dump.includes('Zzyzx'), 'narrative text found in plaintext in the database');
    assert.ok(!dump.includes('whiplash'), 'narrative injury detail found in plaintext in the database');
    const again = await call(app, 'GET', `${BASE}/${s.json.sessionId}`, { token: csr });
    assert.equal(again.status, 200, 'the sealed suggestions must still round-trip');
  } finally { await app.close(); }
});

test('SEC3-005: a 12 MB unterminated TJ-array PDF is parsed within the time budget', async () => {
  const { extractPdfText } = await import('../../src/modules/evidence/parse.mjs');
  const pdf = Buffer.from(`%PDF-1.4\nBT ${'[(a)'.repeat(3_000_000)} ET\n`);
  const t0 = performance.now();
  extractPdfText(pdf);
  const ms = performance.now() - t0;
  assert.ok(ms < 400, `PDF scan of ${Math.round(pdf.length / 1e6)} MB took ${Math.round(ms)} ms (budget ~100 ms plus slack)`);
});

test('SEC3-006: a multipart body made of thousands of empty parts is rejected with 400, fast', async () => {
  const app = await bootHolder();
  try {
    const id = (await (async () => {
      const r = await call(app, 'POST', '/api/v1/claims', { token: app.as(T1, ['csr'], 'csr-mp'), body: {
        lob: 'personal_auto', channel: 'csr_phone', policyNumber: POLICY,
        lossEvent: { lossDate: '2026-10-01', cause: 'collision', description: 'test', injuriesReported: false },
        parties: [{ roles: ['insured'], kind: 'person', firstName: 'Avery', lastName: 'Testwell' }],
      } });
      assert.equal(r.status, 201, r.text.slice(0, 200));
      return r.json.id;
    })());
    const body = Buffer.from('--a\r\n\r\n'.repeat(2_000_000)); // ~14 MB, under the body limit
    const t0 = performance.now();
    const res = await fetch(`${app.url}/api/v1/claims/${id}/documents`, {
      method: 'POST', headers: { authorization: `Bearer ${app.as(T1, ['csr'], 'csr-mp')}`, 'content-type': 'multipart/form-data; boundary=a' }, body,
    });
    const ms = performance.now() - t0;
    assert.equal(res.status, 400, `multipart bomb gave ${res.status}`);
    assert.ok(ms < 1500, `request took ${Math.round(ms)} ms`);
  } finally { await app.close(); }
});
