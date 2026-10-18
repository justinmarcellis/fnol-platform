import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  bootHarness, createApi, listTenants, loadSynthetic, runStep, NotImplemented, requireImplemented,
  outboxEvents, compareExpected, FRAUD_THRESHOLD,
} from './harness.mjs';

/**
 * Definition-of-done proof (S3-QE-01). For each line of business, on the tenant that offers it:
 * report -> upload -> extraction -> coverage -> triage (severity, fraud, subrogation, explanation)
 * -> routing -> adjuster view with AI summary -> claim.routed webhook (valid HMAC) -> core-suite
 * adapter received the mapped ACORD-aligned payload. Everything goes over HTTP with role tokens.
 * Missing modules/endpoints are NotImplemented, which becomes t.todo (never a silent skip).
 */

const SEED = 'dod-1';
const WAIT_MS = 5000;

// How each line of business reports in. Intake channels are mixed on purpose.
const CASES = [
  { lob: 'personal_auto', scenario: 'auto_glass_only', channel: 'claimant_web', role: 'claimant', via: 'intake' },
  { lob: 'homeowners', scenario: 'home_water_small', channel: 'csr_phone', role: 'csr', via: 'claims' },
  { lob: 'commercial_auto', scenario: 'commercial_auto_fleet_collision', channel: 'api', role: 'integration', via: 'claims' },
];

// 1x1 transparent PNG and a minimal PDF: tiny, real magic bytes.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TINY_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

/** Tenant that offers `lob` (enabled) on `channel`, derived from tenants/*.json. */
function tenantFor(lob, channel) {
  for (const t of listTenants()) {
    const entry = (t.config.lobs ?? []).find((l) => l.id === lob && l.enabled !== false);
    if (entry && (entry.channels ?? []).includes(channel)) return { id: t.id, config: t.config, lobConfig: entry };
  }
  return null;
}

/** Poll until fn returns a truthy value; bounded by a deadline, no fixed sleeps. */
async function waitFor(fn, { timeoutMs = WAIT_MS, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Local webhook receiver on port 0. Records raw bodies and headers; always answers 200. */
async function startReceiver() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let json = null;
      try { json = JSON.parse(raw.toString('utf8')); } catch { /* not json */ }
      requests.push({ headers: req.headers, raw, json });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/hook`,
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

/** HMAC-SHA256 hex of the raw body, computed independently of the platform's signing helper. */
const hmacHex = (secret, raw) => crypto.createHmac('sha256', secret).update(raw).digest('hex');

/** Claimant flow: guided intake session answered from the scenario, then submit. Returns the claim. */
async function reportViaIntake(api, scenario, { channel, role }) {
  const fixed = { injuries: false, vehicle_drivable: true };
  let r = requireImplemented(await api('POST', '/intake/sessions', {
    role, body: { lob: scenario.lob, lossType: scenario.lossType, channel, locale: 'en', policyNumber: scenario.claimCreate.policyNumber },
  }), 'POST /intake/sessions');
  assert.equal(r.status, 201, `start session: ${r.text}`);
  const sessionId = r.json.sessionId;
  for (let i = 0; i < 40; i += 1) {
    r = await api('GET', `/intake/sessions/${sessionId}/next-question`, { role });
    assert.equal(r.status, 200, `next-question: ${r.text}`);
    const q = r.json.question;
    if (!q) break;
    const byType = {
      date: scenario.intakeAnswers.lossDate,
      boolean: q.id in fixed ? fixed[q.id] : true,
      select: q.options?.[0]?.value,
      disclosure: true,
      longtext: scenario.intakeAnswers.lossDescription ?? 'Reported by the claimant.',
      text: scenario.intakeAnswers.lossDescription ?? 'Reported by the claimant.',
    };
    assert.ok(q.type in byType, `intake test cannot answer question type ${q.type} (${q.id})`);
    r = await api('POST', `/intake/sessions/${sessionId}/answers`, { role, body: { questionId: q.id, value: byType[q.type] } });
    assert.equal(r.status, 200, `answer ${q.id}: ${r.text}`);
  }
  r = await api('POST', `/intake/sessions/${sessionId}/submit`, { role });
  assert.equal(r.status, 201, `submit: ${r.text}`);
  // The submit response is a summary (id, claimNumber, status); fetch the full claim record.
  assert.ok(r.json.id, 'submit returns the claim id');
  const full = await api('GET', `/claims/${r.json.id}`, { role: 'adjuster' });
  assert.equal(full.status, 200, `get claim: ${full.text}`);
  return full.json;
}

/** Documents to upload: the scenario's own plus a tiny real PNG and PDF. */
function documentsFor(scenario) {
  const docs = [];
  for (const d of scenario.documents ?? []) {
    const content = d.contentBase64 ? Buffer.from(d.contentBase64, 'base64') : Buffer.from(d.text ?? '');
    if (content.length === 0) continue;
    docs.push({ kind: d.kind, filename: d.filename, contentType: d.contentType, contentBase64: content.toString('base64') });
  }
  docs.push({ kind: 'photo', filename: 'tiny.png', contentType: 'image/png', contentBase64: TINY_PNG.toString('base64') });
  docs.push({ kind: 'police_report', filename: 'tiny.pdf', contentType: 'application/pdf', contentBase64: TINY_PDF.toString('base64') });
  return docs;
}

let h;
let synthetic;

before(async () => {
  synthetic = await loadSynthetic();
  h = await bootHarness();
});

after(async () => {
  if (h) await h.close();
});

for (const c of CASES) {
  test(`DoD: ${c.lob} via ${c.channel} (${c.role})`, async (t) => {
    const tenant = tenantFor(c.lob, c.channel);
    assert.ok(tenant, `no tenant in tenants/*.json offers ${c.lob} on ${c.channel}`);
    const tenantId = tenant.id;
    const state = tenant.lobConfig.states?.[0];
    const scenario = synthetic.generateScenario(c.scenario, { seed: SEED, tenantId, state });
    assert.equal(scenario.lob, c.lob, 'scenario is for this line of business');
    const api = createApi(h.app, tenantId);
    const st = { claim: null, actual: {}, webhook: null };
    const need = (what) => { if (!st.claim) throw new NotImplemented(`no claim was created (${what} needs the report step)`); };

    const receiver = await startReceiver();
    t.after(async () => {
      await receiver.close();
      h.ctx.clock.reset?.();
    });

    // Seed the mock policy system and report on the scenario's own reported date (report lag is a fraud cue).
    const seed = h.ctx.forTenant(tenantId).modules?.coverage?.seedPolicies;
    if (typeof seed === 'function') await seed.call(h.ctx.forTenant(tenantId).modules.coverage, [scenario.policy]);
    h.ctx.clock.set(`${scenario.meta.reportedDate}T15:00:00.000Z`);

    await t.test('webhook subscription for claim.routed (tenant_admin)', (s) => runStep(s, async () => {
      const res = requireImplemented(await api('POST', '/integrations/webhooks', {
        role: 'tenant_admin', body: { url: receiver.url, eventTypes: ['claim.routed'], description: `dod ${c.lob}` },
      }), 'POST /integrations/webhooks');
      assert.equal(res.status, 201, res.text);
      assert.match(res.json.secret, /^whsec_/, 'secret is returned once on create');
      st.webhook = { id: res.json.id, secret: res.json.secret };
    }));

    await t.test(`report (${c.channel})`, (s) => runStep(s, async () => {
      if (h.ctx.modules?.claims === undefined) throw new NotImplemented('ctx.modules.claims is not defined');
      let claim;
      if (c.via === 'intake') {
        claim = await reportViaIntake(api, scenario, c);
      } else {
        const body = { ...scenario.claimCreate, channel: c.channel };
        const res = requireImplemented(await api('POST', '/claims', { role: c.role, body }), 'POST /claims');
        assert.equal(res.status, 201, `POST /claims: ${res.text}`);
        claim = res.json;
      }
      assert.ok(claim.id, 'claim has an id');
      assert.equal(claim.lob, c.lob);
      assert.equal(claim.channel, c.channel);
      assert.equal(claim.tenantId, tenantId);
      assert.match(claim.claimNumber, new RegExp(`^${tenant.config.claimNumberPrefix}-`), 'tenant claim number prefix');
      st.claim = claim;
      await h.ctx.bus.drain();
      assert.ok(outboxEvents(h.ctx, tenantId, { type: 'claim.reported', claimId: claim.id }).length > 0, 'claim.reported published');
    }));

    await t.test('upload (PDF, PNG, scenario documents) and extraction', (s) => runStep(s, async () => {
      need('upload');
      const uploaded = [];
      for (const d of documentsFor(scenario)) {
        const res = requireImplemented(await api('POST', `/claims/${st.claim.id}/documents`, { role: c.role, body: d }), 'POST /claims/{id}/documents');
        assert.equal(res.status, 201, `upload ${d.filename}: ${res.text}`);
        assert.equal(res.json.extraction?.status, 'pending', 'extraction starts pending');
        uploaded.push(res.json);
      }
      assert.ok(uploaded.some((d) => d.contentType === 'application/pdf') && uploaded.some((d) => d.contentType === 'image/png'), 'PDF and PNG uploaded');
      await h.ctx.bus.drain();
      const items = await waitFor(async () => {
        const res = await api('GET', `/claims/${st.claim.id}/documents`, { role: 'adjuster' });
        return res.status === 200 && res.json.items.length === uploaded.length && res.json.items.every((d) => d.extraction?.status !== 'pending') ? res.json.items : null;
      }, { what: 'extraction to finish for every document' });
      for (const d of items) {
        assert.ok(['extracted', 'partial', 'failed', 'needs_review', 'skipped'].includes(d.extraction.status), `extraction status ${d.extraction.status}`);
        assert.ok(Array.isArray(d.extraction.fields), 'extraction has a fields array');
      }
      const estimate = items.find((d) => d.kind === 'estimate');
      if (estimate) assert.ok(estimate.extraction.fields.some((f) => f.name === 'estimateTotal'), 'estimate total extracted');
      assert.ok(outboxEvents(h.ctx, tenantId, { type: 'claim.evidence.added', claimId: st.claim.id }).length >= uploaded.length, 'claim.evidence.added per upload');
      assert.ok(outboxEvents(h.ctx, tenantId, { type: 'claim.evidence.extracted', claimId: st.claim.id }).length > 0, 'claim.evidence.extracted published');
    }));

    await t.test('coverage verified', (s) => runStep(s, async () => {
      need('coverage');
      await h.ctx.bus.drain();
      const res = requireImplemented(await api('GET', `/claims/${st.claim.id}/coverage`, { role: 'adjuster' }), 'GET /claims/{id}/coverage');
      assert.equal(res.status, 200, res.text);
      const v = res.json.verification;
      assert.ok(v?.checks?.length > 0, 'coverage checks present');
      assert.equal(res.json.policy?.lob, c.lob, 'policy snapshot is for this line of business');
      st.actual.coverageStatus = v.outcome;
      assert.ok(outboxEvents(h.ctx, tenantId, { type: 'claim.coverage.verified', claimId: st.claim.id }).length > 0, 'claim.coverage.verified published');
      if (c.via === 'claims') compareExpected(scenario.expected, { coverageStatus: v.outcome });
      // A guided claimant report has no vehicle detail, so the policy check may legitimately ask for review.
      else assert.ok(['covered', 'needs_review'].includes(v.outcome), `coverage outcome ${v.outcome}`);
    }));

    await t.test('triage: severity, fraud, subrogation, explanation', (s) => runStep(s, async () => {
      need('triage');
      await h.ctx.bus.drain();
      const res = requireImplemented(await api('GET', `/claims/${st.claim.id}/triage`, { role: 'adjuster' }), 'GET /claims/{id}/triage');
      assert.equal(res.status, 200, res.text);
      const tr = res.json;
      assert.ok(['minor', 'moderate', 'major', 'severe'].includes(tr.severityBand), `severity band ${tr.severityBand}`);
      assert.ok(Number.isInteger(tr.severityScore) && tr.severityScore >= 0 && tr.severityScore <= 100, 'severity score 0-100');
      assert.equal(typeof tr.fraud?.score, 'number', 'fraud score');
      assert.ok(Array.isArray(tr.fraud.indicators), 'fraud indicators');
      assert.equal(typeof tr.subrogation?.flag, 'boolean', 'subrogation flag');
      assert.ok(typeof tr.explanation === 'string' && tr.explanation.length > 20, 'plain-language explanation');
      assert.ok(tr.ai?.provider && tr.ai?.model, 'AI provenance on triage');
      st.actual.severityBand = tr.severityBand;
      st.actual.fraud = tr.fraud.score >= FRAUD_THRESHOLD;
      st.actual.subrogation = tr.subrogation.flag;
      assert.ok(outboxEvents(h.ctx, tenantId, { type: 'claim.triaged', claimId: st.claim.id }).length > 0, 'claim.triaged published');
      // The claimant-entered claim has only the guided answers, so full scenario expectations apply to staff-entered claims.
      if (c.via === 'claims') compareExpected(scenario.expected, st.actual);
    }));

    await t.test('routing decision', (s) => runStep(s, async () => {
      need('routing');
      await h.ctx.bus.drain();
      const res = requireImplemented(await api('GET', `/claims/${st.claim.id}/routing`, { role: 'adjuster' }), 'GET /claims/{id}/routing');
      assert.equal(res.status, 200, res.text);
      const queues = (tenant.config.queues ?? []).map((q) => q.id);
      assert.ok(queues.includes(res.json.queue), `queue ${res.json.queue} is one of the tenant's queues ${queues}`);
      assert.equal(typeof res.json.fastTrack, 'boolean');
      assert.ok(res.json.ruleIds?.length > 0 && res.json.reasons?.length > 0, 'decision cites rules and reasons');
      st.actual.fastTrack = res.json.fastTrack;
      st.routing = res.json;
      assert.ok(outboxEvents(h.ctx, tenantId, { type: 'claim.routed', claimId: st.claim.id }).length > 0, 'claim.routed published');
      if (c.via === 'claims') compareExpected(scenario.expected, { fastTrack: res.json.fastTrack });
      if (c.lob === 'commercial_auto') assert.equal(res.json.fastTrack, false, 'commercial auto is never fast tracked');
    }));

    await t.test('adjuster view with AI summary', (s) => runStep(s, async () => {
      need('adjuster view');
      if (h.ctx.modules?.adjuster === undefined) throw new NotImplemented('ctx.modules.adjuster is not defined');
      const res = requireImplemented(await api('GET', `/adjuster/claims/${st.claim.id}/view`, { role: 'adjuster' }), 'GET /adjuster/claims/{id}/view');
      assert.equal(res.status, 200, res.text);
      const v = res.json;
      assert.equal(v.claim?.id, st.claim.id);
      assert.equal(v.coverage?.outcome, st.actual.coverageStatus);
      assert.equal(v.triage?.severityBand, st.actual.severityBand);
      if (st.routing) assert.equal(v.routing?.queue, st.routing.queue);
      assert.ok(typeof v.summary?.text === 'string' && v.summary.text.length > 20, 'AI summary text');
      assert.ok(Array.isArray(v.summary.citedFacts) && v.summary.citedFacts.length > 0, 'summary cites facts');
      assert.ok(v.summary.ai?.provider && v.summary.ai?.model, 'AI provenance on summary');
      assert.ok(Array.isArray(v.nextActions), 'next actions');
      assert.ok(v.documents?.length > 0, 'documents listed');
    }));

    await t.test('claim.routed webhook delivered with a valid HMAC signature', (s) => runStep(s, async () => {
      need('webhook');
      if (!st.webhook) throw new NotImplemented('webhook subscription was not created');
      const hit = await waitFor(() => receiver.requests.find((r) => r.json?.type === 'claim.routed' && r.json.subject === st.claim.id), { what: 'claim.routed delivery at the local receiver' });
      assert.equal(hit.headers['x-fnol-signature'], hmacHex(st.webhook.secret, hit.raw), 'X-FNOL-Signature is HMAC-SHA256 of the raw body');
      assert.notEqual(hit.headers['x-fnol-signature'], hmacHex('whsec_wrong', hit.raw), 'a wrong secret does not verify');
      assert.equal(hit.headers['x-fnol-event-type'], 'claim.routed');
      assert.equal(hit.headers['x-fnol-event-id'], hit.json.id);
      assert.equal(hit.json.tenantId, tenantId);
      assert.equal(hit.json.specversion, '1.0');
      assert.equal(hit.json.data.claimId, st.claim.id);
      assert.equal(receiver.requests.some((r) => r.json?.type && r.json.type !== 'claim.routed'), false, 'only the subscribed event type is delivered');
      const delivery = await waitFor(async () => {
        const res = await api('GET', `/integrations/webhooks/${st.webhook.id}/deliveries`, { role: 'tenant_admin' });
        return res.status === 200 && res.json.items.find((d) => d.eventId === hit.json.id && d.status === 'succeeded');
      }, { what: 'delivery log to show succeeded' });
      assert.equal(delivery.responseStatus, 200);
    }));

    await t.test('core-suite adapter received the mapped ACORD-aligned payload', (s) => runStep(s, async () => {
      need('adapter');
      await h.ctx.bus.drain();
      const adapters = requireImplemented(await api('GET', '/integrations/adapters', { role: 'tenant_admin' }), 'GET /integrations/adapters');
      const adapter = adapters.json.items.find((a) => a.id === 'core-claims-suite');
      if (!adapter) throw new NotImplemented('core-claims-suite adapter is not registered');
      assert.equal(adapter.format, 'acord-aligned-json');
      const received = await waitFor(async () => {
        const res = await api('GET', '/integrations/fake-core/claims', { role: 'tenant_admin' });
        if (res.status === 404) throw new NotImplemented('fake core suite routes are not mounted');
        if (res.status !== 200) throw new Error(`fake core list: ${res.status} ${res.text}`);
        return res.json.items.find((r) => r.claimRef === st.claim.claimNumber);
      }, { what: 'fake core suite to receive the claim' });
      assert.match(received.coreClaimNumber, /^CORE-\d{4}-\d{6}$/);
      const p = received.payload;
      if (p.claimsNotificationAddRq) {
        // ACORD-aligned nested JSON (profile A).
        const rq = p.claimsNotificationAddRq;
        assert.equal(rq.claimsOccurrence.itemIdInfo.agencyId, st.claim.claimNumber);
        assert.equal(rq.policy.policyNumber, scenario.claimCreate.policyNumber);
        assert.equal(rq.policy.lobCd, tenant.lobConfig.acordLobCd, 'ACORD LOB code from tenant config');
        assert.equal(rq.claimsOccurrence.lossDt, scenario.claimCreate.lossEvent.lossDate);
        assert.ok(rq.claimsOccurrence.lossCauseCd, 'loss cause code mapped');
        if (c.via === 'claims') assert.ok(rq.claimsParty?.length > 0, 'parties mapped');
      } else {
        // Flat ACORD-derived record (profile B).
        assert.equal(p.CLAIM_REF, st.claim.claimNumber);
        assert.equal(p.POLICY_NO, scenario.claimCreate.policyNumber);
        assert.ok(p.LOB_CODE && p.LOSS_DATE && p.LOSS_CAUSE_CODE, 'core fields mapped');
      }
      // The push is also visible through the preview endpoint with the same claim reference.
      const prev = await api('GET', `/integrations/adapters/core-claims-suite/preview/${st.claim.id}`, { role: 'tenant_admin' });
      assert.equal(prev.status, 200, prev.text);
      assert.ok(prev.json.payload && Array.isArray(prev.json.unmapped));
    }));
  });
}

test('DoD: upload guards (magic bytes and 10 MB limit)', async (t) => {
  const tenant = tenantFor('personal_auto', 'api') ?? tenantFor('personal_auto', 'csr_phone');
  assert.ok(tenant, 'a tenant offers personal_auto');
  const scenario = synthetic.generateScenario('auto_glass_only', { seed: SEED, tenantId: tenant.id, state: tenant.lobConfig.states?.[0] });
  const api = createApi(h.app, tenant.id);
  const seed = h.ctx.forTenant(tenant.id).modules?.coverage?.seedPolicies;
  if (typeof seed === 'function') await seed.call(h.ctx.forTenant(tenant.id).modules.coverage, [scenario.policy]);
  h.ctx.clock.set(`${scenario.meta.reportedDate}T15:00:00.000Z`);
  t.after(() => h.ctx.clock.reset?.());
  await runStep(t, async () => {
    const created = requireImplemented(await api('POST', '/claims', { role: 'integration', body: scenario.claimCreate }), 'POST /claims');
    assert.equal(created.status, 201, created.text);
    const url = `/claims/${created.json.id}/documents`;
    const upload = (buf, contentType, filename) => api('POST', url, { role: 'integration', body: { kind: 'other', filename, contentType, contentBase64: buf.toString('base64') } });
    requireImplemented(await upload(TINY_PNG, 'image/png', 'ok.png'), 'POST /claims/{id}/documents');
    assert.equal((await upload(TINY_PNG, 'application/pdf', 'liar.pdf')).status, 415, 'declared type must match magic bytes');
    assert.equal((await upload(Buffer.from('MZ not an image'), 'image/png', 'fake.png')).status, 415);
    const big = Buffer.concat([TINY_PDF, Buffer.alloc(10 * 1024 * 1024 + 1)]);
    assert.equal((await upload(big, 'application/pdf', 'big.pdf')).status, 413, 'files over 10 MB are refused');
    assert.equal((await upload(TINY_PDF, 'application/pdf', 'ok.pdf')).status, 201, 'a valid PDF is still accepted afterwards');
  });
});

test('DoD: every line of business is offered by at least one tenant', (t) => {
  const offered = new Set(listTenants().flatMap((x) => (x.config.lobs ?? []).filter((l) => l.enabled !== false).map((l) => l.id)));
  for (const lob of ['personal_auto', 'homeowners', 'commercial_auto']) assert.ok(offered.has(lob), `${lob} is offered by a tenant`);
});
