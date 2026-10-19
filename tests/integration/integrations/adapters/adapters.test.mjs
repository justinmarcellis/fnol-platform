import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootAdapters, call, startCore, publish, routed } from './helpers.mjs';
import { state, reset, putBundle } from './fakes.mjs';
import { autoBundle, homeBundle } from '../../../unit/integrations/adapters/fixtures.mjs';

let app;
let core;
const AUTO = autoBundle.claim.id;
const sync = (tenant, claimId = AUTO) => app.ctx.db.forTenant(tenant).get('SELECT * FROM core_sync WHERE claim_id = ?', claimId);
const received = (tenant) => app.ctx.db.forTenant(tenant).all('SELECT * FROM fake_core_claims ORDER BY seq');
const tok = (tenant = 'alpha', roles = ['supervisor']) => app.token(roles, tenant);

before(async () => { app = await bootAdapters(); core = await startCore(); });
after(async () => { await core.close(); await app.close(); });
beforeEach(() => {
  reset();
  putBundle('alpha', autoBundle);
  putBundle('bravo', { ...autoBundle, claim: { ...autoBundle.claim, tenantId: 'bravo' } });
  putBundle('manual', autoBundle);
  putBundle('early', autoBundle);
  putBundle('other', autoBundle);
  putBundle('httpt', autoBundle);
  putBundle('beta', autoBundle);
  for (const t of ['alpha', 'bravo', 'manual', 'early', 'httpt', 'beta']) {
    app.ctx.db.forTenant(t).run('DELETE FROM core_sync');
    app.ctx.db.forTenant(t).run('DELETE FROM core_sync_events');
    app.ctx.db.forTenant(t).run('DELETE FROM fake_core_claims');
  }
  core.requests.length = 0;
  core.status = 201;
});

test('createAdapterService exposes the agreed shape', async () => {
  const { createAdapterService } = await import('../../../../src/modules/integrations/adapters/index.mjs');
  const svc = createAdapterService(app.tctx('alpha'));
  for (const fn of ['listAdapters', 'previewMapping', 'pushClaim', 'routes', 'init']) assert.equal(typeof svc[fn], 'function', fn);
});

test('listAdapters shows core-claims-suite enabled with the tenant profile', async () => {
  const a = await call(app, 'GET', '/api/v1/integrations/adapters', { token: tok('alpha') });
  assert.equal(a.status, 200);
  assert.deepEqual(a.json.items, [{ id: 'core-claims-suite', port: 'claims', format: 'acord-aligned-json', enabled: true, profiles: ['A', 'B'], profile: 'A' }]);
  const b = await call(app, 'GET', '/api/v1/integrations/adapters', { token: tok('bravo') });
  assert.equal(b.json.items[0].profile, 'B');
  const o = await call(app, 'GET', '/api/v1/integrations/adapters', { token: tok('other') });
  assert.equal(o.json.items[0].enabled, false);
});

test('previewMapping: payload, unmapped, warnings; masked PII; nothing sent or recorded', async () => {
  const r = await call(app, 'GET', `/api/v1/integrations/adapters/core-claims-suite/preview/${AUTO}`, { token: tok('alpha', ['adjuster']) });
  assert.equal(r.status, 200);
  assert.equal(r.json.adapterId, 'core-claims-suite');
  assert.equal(r.json.format, 'acord-aligned-json');
  assert.ok(r.json.payload.claimsNotificationAddRq.claimsOccurrence);
  assert.ok(Array.isArray(r.json.unmapped) && r.json.unmapped.includes('claim.documentIds'));
  assert.ok(r.json.warnings.some((w) => /masked/.test(w)));
  assert.ok(!r.text.includes('Example') && !r.text.includes('ada@example.test'));
  assert.equal(sync('alpha'), undefined);
  assert.equal(received('alpha').length, 0);
  assert.equal(state.externalRefs.length, 0);
});

test('previewMapping honours the tenant profile (B is flat) and 404s unknown adapter or claim', async () => {
  const r = await call(app, 'GET', `/api/v1/integrations/adapters/core-claims-suite/preview/${AUTO}`, { token: tok('bravo') });
  assert.equal(r.json.profile, 'B');
  assert.equal(r.json.payload.LOSS_DATE, '20261017');
  assert.equal(r.json.payload.CLAIM_REF, 'ALP-2026-000123');
  assert.equal((await call(app, 'GET', `/api/v1/integrations/adapters/nope/preview/${AUTO}`, { token: tok('alpha') })).status, 404);
  const missing = await call(app, 'GET', '/api/v1/integrations/adapters/core-claims-suite/preview/clm_missing', { token: tok('alpha') });
  assert.equal(missing.status, 404);
});

test('invalid profile in tenant settings is a 422', async () => {
  const cfg = structuredClone(app.tenantConfigs.alpha);
  app.ctx.tenants.put('alpha', { ...cfg, integrations: { claimsPort: { settings: { profile: 'Z' } } } }, 'test');
  try {
    const r = await call(app, 'GET', `/api/v1/integrations/adapters/core-claims-suite/preview/${AUTO}`, { token: tok('alpha') });
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, 'invalid_adapter_settings');
  } finally {
    app.ctx.tenants.put('alpha', cfg, 'test');
  }
});

test('fake core receiver: requires auth, validates, stores per tenant, returns a core claim number', async () => {
  const path = '/api/v1/integrations/fake-core/claims';
  assert.equal((await call(app, 'POST', path, { body: { CLAIM_REF: 'X-1' } })).status, 401);
  assert.equal((await call(app, 'POST', path, { token: tok('alpha', ['claimant']), body: { CLAIM_REF: 'X-1' } })).status, 403);
  const bad = await call(app, 'POST', path, { token: tok('alpha', ['integration']), body: { nothing: true } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'invalid_payload');

  const one = await call(app, 'POST', path, { token: tok('alpha', ['integration']), body: { CLAIM_REF: 'X-1', LOSS_DESC: 'a' } });
  assert.equal(one.status, 201);
  assert.match(one.json.coreClaimNumber, /^CORE-\d{4}-000001$/);
  const two = await call(app, 'POST', path, { token: tok('alpha', ['integration']), body: { CLAIM_REF: 'X-2' } });
  assert.match(two.json.coreClaimNumber, /000002$/);
  const again = await call(app, 'POST', path, { token: tok('alpha', ['integration']), body: { CLAIM_REF: 'X-1', LOSS_DESC: 'b' } });
  assert.equal(again.json.coreClaimNumber, one.json.coreClaimNumber);
  assert.equal(again.json.duplicate, true);

  const beta = await call(app, 'POST', path, { token: tok('beta', ['integration']), body: { CLAIM_REF: 'X-1' } });
  assert.match(beta.json.coreClaimNumber, /000001$/);

  const list = await call(app, 'GET', path, { token: tok('alpha', ['carrier_admin']) });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.items.map((i) => i.claimRef), ['X-1', 'X-2', 'X-1']);
  assert.equal(list.json.items[0].payload.LOSS_DESC, 'a');
  const betaList = await call(app, 'GET', path, { token: tok('beta', ['carrier_admin']) });
  assert.equal(betaList.json.items.length, 1);
});

test('pushClaim (manual route) syncs through the fake core, records core_sync, sets the external ref, audits', async () => {
  const r = await call(app, 'POST', `/api/v1/integrations/adapters/core-claims-suite/push/${AUTO}`, { token: tok('alpha', ['supervisor']) });
  assert.equal(r.status, 202);
  assert.equal(r.json.status, 'synced');
  assert.match(r.json.externalId, /^CORE-\d{4}-\d{6}$/);
  const row = sync('alpha');
  assert.equal(row.status, 'synced');
  assert.equal(row.external_id, r.json.externalId);
  assert.match(row.last_payload_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.attempts, 1);
  assert.deepEqual(state.externalRefs, [{ tenantId: 'alpha', claimId: AUTO, ref: { system: 'core-claims-suite', id: r.json.externalId, status: 'synced' } }]);
  const stored = received('alpha');
  assert.equal(stored.length, 1);
  assert.ok(!stored[0].payload_enc.includes('Example'), 'payload is encrypted at rest');
  const listed = await call(app, 'GET', '/api/v1/integrations/fake-core/claims', { token: tok('alpha', ['carrier_admin']) });
  assert.equal(listed.json.items[0].payload.claimsNotificationAddRq.claimsParty[0].generalPartyInfo.nameInfo.personName.surname, 'Example');
  const audit = app.tctx('alpha').audit.list({ action: 'integrations.core.push' });
  assert.equal(audit.length, 1);
  assert.ok(!JSON.stringify(audit).includes('Example'));
  // manual resend always sends again, keeping the core claim number
  const again = await call(app, 'POST', `/api/v1/integrations/adapters/core-claims-suite/push/${AUTO}`, { token: tok('alpha', ['supervisor']) });
  assert.equal(again.json.externalId, r.json.externalId);
  assert.equal(sync('alpha').attempts, 2);
  assert.equal(received('alpha').length, 2);
});

test('pushClaim: unknown adapter 404, adapter not enabled for the tenant 409', async () => {
  assert.equal((await call(app, 'POST', `/api/v1/integrations/adapters/nope/push/${AUTO}`, { token: tok('alpha') })).status, 404);
  const r = await call(app, 'POST', `/api/v1/integrations/adapters/core-claims-suite/push/${AUTO}`, { token: tok('other') });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'adapter_not_enabled');
});

test('claim.routed triggers one push per event; same payload hash on a later event is a no-op', async () => {
  const first = await publish(app, 'alpha', 'claim.routed', routed(AUTO));
  assert.equal(received('alpha').length, 1);
  assert.equal(sync('alpha').status, 'synced');
  assert.equal(sync('alpha').last_event_id, first.id);
  assert.equal(state.externalRefs.length, 1);

  // a second routed event for the unchanged claim: payload hash unchanged -> nothing sent
  await publish(app, 'alpha', 'claim.routed', routed(AUTO));
  assert.equal(received('alpha').length, 1);
  assert.equal(state.externalRefs.length, 1);

  // the claim changes -> new hash -> sent again with the same core number
  const changed = structuredClone(autoBundle);
  changed.claim.lossEvent.description = 'Updated narrative.';
  putBundle('alpha', changed);
  await publish(app, 'alpha', 'claim.routed', routed(AUTO));
  assert.equal(received('alpha').length, 2);
  assert.equal(received('alpha')[1].core_claim_number, received('alpha')[0].core_claim_number);
});

test('the same event id never pushes twice, even when delivered to the service again', async () => {
  const svc = app.svc('alpha');
  const a = await svc.pushClaim('core-claims-suite', AUTO, { actor: 'system:integrations', eventId: 'evt_dup_1' });
  assert.equal(a.status, 'synced');
  const changed = structuredClone(autoBundle);
  changed.claim.lossEvent.description = 'changed between deliveries';
  putBundle('alpha', changed);
  const b = await svc.pushClaim('core-claims-suite', AUTO, { actor: 'system:integrations', eventId: 'evt_dup_1' });
  assert.equal(b.duplicateEvent, true);
  assert.equal(b.externalId, a.externalId);
  assert.equal(received('alpha').length, 1);
  assert.equal(app.ctx.db.forTenant('alpha').all('SELECT * FROM core_sync_events WHERE event_id = ?', 'evt_dup_1').length, 1);
});

test('pushOn is honoured per tenant: manual never pushes, claim.reported pushes only on reported', async () => {
  await publish(app, 'manual', 'claim.routed', routed(AUTO));
  await publish(app, 'manual', 'claim.reported', { claimId: AUTO });
  assert.equal(sync('manual'), undefined);

  await publish(app, 'early', 'claim.routed', routed(AUTO));
  assert.equal(sync('early'), undefined);
  await publish(app, 'early', 'claim.reported', { claimId: AUTO });
  assert.equal(sync('early').status, 'synced');
});

test('tenant isolation: pushes land in the pushing tenant only, with that tenant profile', async () => {
  await publish(app, 'bravo', 'claim.routed', routed(AUTO));
  assert.equal(received('bravo').length, 1);
  assert.equal(received('alpha').length, 0);
  const list = await call(app, 'GET', '/api/v1/integrations/fake-core/claims', { token: tok('bravo', ['carrier_admin']) });
  assert.equal(list.json.items[0].payload.CLAIM_REF, 'ALP-2026-000123');
  assert.equal((await call(app, 'GET', '/api/v1/integrations/fake-core/claims', { token: tok('alpha', ['carrier_admin']) })).json.items.length, 0);
  assert.equal(sync('alpha'), undefined);
});

test('HTTP target: sends the mapped payload to the configured URL and records the external number', async () => {
  const cfg = app.tenantConfigs.httpt;
  app.ctx.tenants.put('httpt', { ...cfg, integrations: { claimsPort: { settings: { profile: 'B', target: { url: core.url } } } } }, 'test');
  core.number = 'EXT-777';
  const r = await app.svc('httpt').pushClaim('core-claims-suite', AUTO, { actor: 'u1' });
  assert.deepEqual(r, { externalId: 'EXT-777', status: 'synced' });
  assert.equal(core.requests.length, 1);
  assert.equal(core.requests[0].method, 'POST');
  assert.equal(core.requests[0].body.LOSS_DATE, '20261017');
  assert.equal(sync('httpt').external_id, 'EXT-777');
});

test('send failure is recorded, not thrown; a later success recovers and counts attempts', async () => {
  const cfg = app.tenantConfigs.httpt;
  app.ctx.tenants.put('httpt', { ...cfg, integrations: { claimsPort: { settings: { target: { url: core.url } } } } }, 'test');
  core.status = 500;
  const evt = await publish(app, 'httpt', 'claim.routed', routed(AUTO)).catch((e) => e);
  assert.ok(!(evt instanceof Error));
  const row = sync('httpt');
  assert.equal(row.status, 'failed');
  assert.match(row.last_error, /responded 500/);
  assert.equal(row.external_id, null);
  assert.equal(state.externalRefs.at(-1).ref.status, 'failed');
  assert.equal(app.ctx.bus.outbox('httpt').find((o) => o.id === evt.id)?.status ?? 'delivered', 'delivered');

  const direct = await app.svc('httpt').pushClaim('core-claims-suite', AUTO, { actor: 'u1' });
  assert.equal(direct.status, 'failed');
  assert.equal(direct.externalId, null);
  assert.match(direct.error, /500/);

  core.status = 201;
  core.number = 'EXT-900';
  const ok = await app.svc('httpt').pushClaim('core-claims-suite', AUTO, { actor: 'u1' });
  assert.deepEqual(ok, { externalId: 'EXT-900', status: 'synced' });
  const after = sync('httpt');
  assert.equal(after.status, 'synced');
  assert.equal(after.attempts, 3);
  assert.equal(after.last_error, null);

  // a failed core call keeps the old external id when one existed
  core.status = 503;
  const failedAgain = await app.svc('httpt').pushClaim('core-claims-suite', AUTO, { actor: 'u1' });
  assert.equal(failedAgain.status, 'failed');
  assert.equal(failedAgain.externalId, 'EXT-900');
  assert.equal(sync('httpt').external_id, 'EXT-900');
});

test('unsafe target URLs are refused and recorded as failures', async () => {
  const cfg = app.tenantConfigs.httpt;
  app.ctx.tenants.put('httpt', { ...cfg, integrations: { claimsPort: { settings: { target: { url: 'http://10.0.0.5/claims' } } } } }, 'test');
  const r = await app.svc('httpt').pushClaim('core-claims-suite', AUTO, { actor: 'u1' });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /target url rejected/);
  assert.equal(core.requests.length, 0);
});

test('setExternalRef failure does not break the push', async () => {
  state.failSetExternalRef = true;
  const r = await app.svc('alpha').pushClaim('core-claims-suite', AUTO, { actor: 'u1' });
  assert.equal(r.status, 'synced');
  assert.equal(sync('alpha').status, 'synced');
});

test('event push for a missing claim is logged and swallowed', async () => {
  await publish(app, 'alpha', 'claim.routed', routed('clm_missing'));
  assert.equal(sync('alpha', 'clm_missing'), undefined);
  assert.equal(received('alpha').length, 0);
});

test('home claim without triage/coverage still maps with warnings', async () => {
  putBundle('bravo', homeBundle);
  const r = await app.svc('bravo').previewMapping('core-claims-suite', homeBundle.claim.id);
  assert.ok(r.warnings.some((w) => /no triage/.test(w)));
  assert.equal(r.payload.PROP_COUNT, 1);
});
