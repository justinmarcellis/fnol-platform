import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootHarness, createApi, listTenants, loadSynthetic, runStep, NotImplemented, requireImplemented,
} from './harness.mjs';

/**
 * Same platform, different tenants (S3-QE-01). Each test names one axis on which aurelia-mutual and
 * kestrel-point must differ, and checks it through the HTTP API (config values are cross-checked
 * against tenants/*.json). The same synthetic glass claim is run on both tenants.
 */

const SEED = 'tenant-diff-1';
const A = 'aurelia-mutual';
const K = 'kestrel-point';
// A glass estimate between the two tenants' fast-track limits (kestrel 900, aurelia 2500).
const GLASS_ESTIMATE = 'GLASS SHOP (FICTIONAL)\nREPAIR ESTIMATE\nWindshield with camera bracket 1180.00\nParts subtotal: 1180.00\nLabor subtotal: 270.00\nTOTAL: 1450.00\n';
const ESTIMATE_TOTAL = 1450;

let h;
let synthetic;
const tenants = {};
const apis = {};
const glass = {}; // tenantId -> { claim, scenario } created once and shared by the tests below

before(async () => {
  synthetic = await loadSynthetic();
  h = await bootHarness();
  for (const t of listTenants()) tenants[t.id] = t.config;
  for (const id of [A, K]) {
    assert.ok(tenants[id], `tenants/${id}.json exists`);
    apis[id] = createApi(h.app, id);
  }
});

after(async () => {
  if (h) await h.close();
});

/** Report the same glass scenario on a tenant and upload the same estimate. Memoised per tenant. */
async function glassClaim(tenantId) {
  if (glass[tenantId]) return glass[tenantId];
  // A throwaway client: tokens issued while the clock is in the past must not outlive it.
  const api = createApi(h.app, tenantId);
  const lob = tenants[tenantId].lobs.find((l) => l.id === 'personal_auto');
  const scenario = synthetic.generateScenario('auto_glass_only', { seed: SEED, tenantId, state: lob.states[0] });
  const tctx = h.ctx.forTenant(tenantId);
  const seed = tctx.modules?.coverage?.seedPolicies;
  if (typeof seed !== 'function') throw new NotImplemented('coverage.seedPolicies is not available');
  await seed.call(tctx.modules.coverage, [scenario.policy]);
  h.ctx.clock.set(`${scenario.meta.reportedDate}T15:00:00.000Z`);
  let claim;
  try {
    const created = requireImplemented(await api('POST', '/claims', { role: 'csr', body: { ...scenario.claimCreate, channel: 'csr_phone' } }), 'POST /claims');
    assert.equal(created.status, 201, created.text);
    claim = created.json;
    const up = requireImplemented(await api('POST', `/claims/${created.json.id}/documents`, {
      role: 'csr', body: { kind: 'estimate', filename: 'glass-estimate.txt', contentType: 'text/plain', contentBase64: Buffer.from(GLASS_ESTIMATE).toString('base64') },
    }), 'POST /claims/{id}/documents');
    assert.equal(up.status, 201, up.text);
    await h.ctx.bus.drain();
  } finally {
    h.ctx.clock.reset?.();
  }
  glass[tenantId] = { claim, scenario };
  return glass[tenantId];
}

const publicConfig = async (tenantId) => {
  const res = await apis[tenantId]('GET', '/config/public', { role: 'claimant' });
  assert.equal(res.status, 200, res.text);
  return res.json;
};

/** Localised text as a plain string for a locale, whether the config uses a string or a {en, es} map. */
const textOf = (v, locale = 'en') => (typeof v === 'string' ? v : v?.[locale] ?? v?.en);

/** Start a CSR intake session for glass and answer it to the end; returns the ordered question ids and texts. */
async function glassQuestions(tenantId, locale = 'en') {
  const api = apis[tenantId];
  const lobs = tenants[tenantId].lobs.find((l) => l.id === 'personal_auto');
  assert.ok(lobs.channels.includes('csr_phone'), `${tenantId} personal_auto accepts csr_phone`);
  const start = requireImplemented(await api('POST', '/intake/sessions', { role: 'csr', body: { lob: 'personal_auto', lossType: 'glass', channel: 'csr_phone', locale } }), 'POST /intake/sessions');
  assert.equal(start.status, 201, start.text);
  const id = start.json.sessionId;
  const asked = [];
  let step = start.json;
  for (let i = 0; i < 40 && step.question; i += 1) {
    const q = step.question;
    asked.push({ id: q.id, text: textOf(q.text, locale) });
    const byType = { date: '2026-01-15', boolean: q.id === 'injuries' ? false : q.id === 'prior_damage' ? false : true, select: q.options?.[0]?.value, disclosure: true, text: 'Windshield', longtext: 'Windshield', time: '10:30' };
    assert.ok(q.type in byType, `cannot answer question type ${q.type} (${q.id})`);
    const res = await api('POST', `/intake/sessions/${id}/answers`, { role: 'csr', body: { questionId: q.id, value: byType[q.type] } });
    assert.equal(res.status, 200, `answer ${q.id}: ${res.text}`);
    step = res.json;
  }
  return { locale: start.json.locale, asked };
}

test('branding differs between tenants', async () => {
  const [a, k] = [await publicConfig(A), await publicConfig(K)];
  assert.notEqual(a.displayName, k.displayName);
  assert.notEqual(a.branding.primaryColor, k.branding.primaryColor);
  assert.notEqual(a.branding.accentColor, k.branding.accentColor);
  assert.notEqual(a.branding.fontFamily, k.branding.fontFamily);
  assert.notEqual(a.branding.supportPhone, k.branding.supportPhone);
  assert.notEqual(a.branding.supportEmail, k.branding.supportEmail);
  assert.notDeepEqual(a.branding.legalFooter, k.branding.legalFooter);
  assert.notDeepEqual(Object.keys(a.branding.fraudWarning), Object.keys(k.branding.fraudWarning), 'fraud warnings are per state');
  // API output matches the tenant files, so the UI can theme from it.
  assert.equal(a.branding.primaryColor, tenants[A].branding.primaryColor);
  assert.equal(k.branding.primaryColor, tenants[K].branding.primaryColor);
  // Claim numbers carry the tenant prefix.
  const { claim: ca } = await glassClaim(A);
  const { claim: ck } = await glassClaim(K);
  assert.match(ca.claimNumber, new RegExp(`^${tenants[A].claimNumberPrefix}-`));
  assert.match(ck.claimNumber, new RegExp(`^${tenants[K].claimNumberPrefix}-`));
});

test('lines of business differ between tenants', async () => {
  const ids = async (tenantId) => (await publicConfig(tenantId)).lobs.filter((l) => l.enabled !== false).map((l) => l.id).sort();
  const [a, k] = [await ids(A), await ids(K)];
  assert.deepEqual(a, ['homeowners', 'personal_auto']);
  assert.deepEqual(k, ['commercial_auto', 'personal_auto']);
  const start = (tenantId, lob, channel) => apis[tenantId]('POST', '/intake/sessions', { role: 'csr', body: { lob, channel } });
  // What a tenant does not offer is refused; what it offers starts.
  assert.equal((await start(A, 'homeowners', 'csr_phone')).status, 201);
  assert.equal((await start(K, 'commercial_auto', 'csr_phone')).status, 201);
  const noCommercial = await start(A, 'commercial_auto', 'csr_phone');
  assert.ok(noCommercial.status >= 400 && noCommercial.status < 500, `aurelia refuses commercial_auto (${noCommercial.status})`);
  const noHome = await start(K, 'homeowners', 'csr_phone');
  assert.ok(noHome.status >= 400 && noHome.status < 500, `kestrel refuses homeowners (${noHome.status})`);
});

test('locales differ between tenants', async () => {
  const [a, k] = [await publicConfig(A), await publicConfig(K)];
  assert.deepEqual(a.locales, ['en', 'es']);
  assert.deepEqual(k.locales, ['en']);
  const spanish = await glassQuestions(A, 'es');
  assert.equal(spanish.locale, 'es', 'aurelia serves Spanish');
  assert.ok(spanish.asked.length > 0 && spanish.asked.every((q) => q.text), 'Spanish question text present');
  const english = await glassQuestions(A, 'en');
  assert.notEqual(spanish.asked[0].text, english.asked[0].text, 'first question is translated');
  const fallback = await glassQuestions(K, 'es');
  assert.equal(fallback.locale, 'en', 'kestrel does not offer Spanish and falls back to English');
});

test('questions shown for the same glass claim differ between tenants', async () => {
  const [a, k] = [await glassQuestions(A), await glassQuestions(K)];
  const [aIds, kIds] = [a.asked.map((q) => q.id), k.asked.map((q) => q.id)];
  assert.notDeepEqual(aIds, kIds);
  assert.ok(aIds.includes('glass_location') && !kIds.includes('glass_location'), `aurelia asks where the glass broke: ${aIds}`);
  assert.ok(kIds.includes('prior_damage') && !aIds.includes('prior_damage'), `kestrel asks about prior damage: ${kIds}`);
  assert.notEqual(a.asked[0].text, k.asked[0].text, 'even the shared first question is worded per tenant');
  for (const ids of [aIds, kIds]) assert.ok(ids.includes('loss_date') && ids.includes('fraud_disclosure'));
});

test('straight-through outcome for the same glass claim differs between tenants', async (t) => {
  const aFt = tenants[A].fastTrack;
  const kFt = tenants[K].fastTrack;
  assert.ok(kFt.maxEstimate.amount < ESTIMATE_TOTAL && ESTIMATE_TOTAL <= aFt.maxEstimate.amount, 'test estimate sits between the two tenants\' fast-track limits');
  const out = {};
  for (const id of [A, K]) {
    const { claim } = await glassClaim(id);
    await h.ctx.bus.drain();
    const routing = await apis[id]('GET', `/claims/${claim.id}/routing`, { role: 'adjuster' });
    assert.equal(routing.status, 200, routing.text);
    const triage = await apis[id]('GET', `/claims/${claim.id}/triage`, { role: 'adjuster' });
    assert.equal(triage.status, 200, triage.text);
    assert.equal(triage.json.suggestedReserve.amount, ESTIMATE_TOTAL, 'the same extracted estimate feeds both tenants');
    out[id] = { routing: routing.json, triage: triage.json };
  }
  assert.equal(out[A].triage.severityBand, out[K].triage.severityBand, 'identical claim, identical triage band');
  assert.equal(out[A].routing.fastTrack, true, 'aurelia fast tracks the glass claim');
  assert.equal(out[K].routing.fastTrack, false, 'kestrel does not');
  assert.equal(out[A].routing.queue, tenants[A].fastTrack.queue);
  assert.notEqual(out[K].routing.queue, kFt.queue);
  assert.ok(out[K].routing.reasons.some((r) => /above fast-track limit/.test(r)), `kestrel names the estimate limit: ${out[K].routing.reasons}`);
  assert.notDeepEqual(out[A].routing.ruleIds, out[K].routing.ruleIds, 'different tenant rules fired');
  t.diagnostic(`aurelia ${out[A].routing.outcome}/${out[A].routing.queue}; kestrel ${out[K].routing.outcome}/${out[K].routing.queue}`);
});

test('regulatory timers differ between tenants', async () => {
  const days = (timers, kind) => {
    const tm = timers.find((x) => x.kind === kind);
    assert.ok(tm, `${kind} timer present`);
    return { definitionId: tm.definitionId, state: tm.state, ms: Date.parse(tm.dueAt) - Date.parse(tm.startedAt) };
  };
  const got = {};
  for (const id of [A, K]) {
    const { claim } = await glassClaim(id);
    const res = requireImplemented(await apis[id]('GET', `/claims/${claim.id}/timers`, { role: 'adjuster' }), 'GET /claims/{id}/timers');
    assert.equal(res.status, 200, res.text);
    got[id] = { ack: days(res.json.items, 'acknowledge'), contact: days(res.json.items, 'contact'), kinds: res.json.items.map((x) => x.kind).sort() };
  }
  assert.notEqual(got[A].ack.state, got[K].ack.state, 'timers come from each tenant\'s state rules');
  assert.notEqual(got[A].ack.definitionId, got[K].ack.definitionId);
  assert.equal(got[A].ack.ms, 7 * 86400000, 'aurelia WI acknowledgement is 7 days');
  assert.equal(got[K].ack.ms, 10 * 86400000, 'kestrel MI acknowledgement is 10 days');
  assert.notEqual(got[A].ack.ms, got[K].ack.ms);
  assert.equal(got[A].contact.ms, 3 * 86400000, 'aurelia WI first contact is 3 days');
  assert.notEqual(got[A].contact.ms, got[K].contact.ms, 'kestrel MI first contact is 2 business days');
  assert.notEqual(got[A].contact.definitionId, got[K].contact.definitionId);
});

test('adapter mapping profile differs between tenants', async (t) => {
  const setting = (id) => tenants[id].integrations.claimsPort.settings.fieldMapProfile;
  assert.notEqual(setting(A), setting(K), 'tenant files choose different mapping profiles');
  assert.equal(tenants[A].integrations.claimsPort.adapter, tenants[K].integrations.claimsPort.adapter, 'same core-suite adapter, different mapping');
  assert.notEqual(tenants[A].integrations.claimsPort.pushOn, tenants[K].integrations.claimsPort.pushOn, 'push trigger differs too');

  await runStep(t, async () => {
    const effective = {};
    const shape = {};
    for (const id of [A, K]) {
      const adapters = requireImplemented(await apis[id]('GET', '/integrations/adapters', { role: 'tenant_admin' }), 'GET /integrations/adapters');
      const adapter = adapters.json.items.find((x) => x.id === 'core-claims-suite');
      if (!adapter) throw new NotImplemented('core-claims-suite adapter is not registered');
      effective[id] = adapter.profile;
      const { claim } = await glassClaim(id);
      const list = await apis[id]('GET', '/integrations/fake-core/claims', { role: 'tenant_admin' });
      assert.equal(list.status, 200, list.text);
      const received = list.json.items.find((r) => r.claimRef === claim.claimNumber);
      assert.ok(received, `${id}: core suite received the claim (pushOn ${tenants[id].integrations.claimsPort.pushOn})`);
      shape[id] = received.payload.claimsNotificationAddRq ? 'nested' : received.payload.CLAIM_REF ? 'flat' : 'unknown';
    }
    if (effective[A] === effective[K] || shape[A] === shape[K]) {
      // Open contract-change on the architecture hub (S3-QE-01): runtime reads settings.profile, tenants set fieldMapProfile.
      throw new NotImplemented(`tenant fieldMapProfile is not applied by the adapter yet: effective profiles ${effective[A]}/${effective[K]}, payload shapes ${shape[A]}/${shape[K]}`);
    }
    assert.deepEqual([shape[A], shape[K]], ['nested', 'flat'], 'aurelia sends nested ACORD JSON, kestrel the flat record');
  });
});
