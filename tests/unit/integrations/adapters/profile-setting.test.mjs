import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAdapterService, normaliseProfile } from '../../../../src/modules/integrations/adapters/index.mjs';
import { autoBundle, mapOpts } from './fixtures.mjs';

const tenantFile = (n) => JSON.parse(fs.readFileSync(new URL(`../../../../tenants/${n}.json`, import.meta.url), 'utf8'));

class AppError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

function svcFor(config) {
  const ctx = {
    AppError,
    tenant: { id: 'alpha', config },
    clock: { nowIso: () => '2026-10-18T14:02:11.000Z' },
    modules: { claims: { getClaimBundle: async () => autoBundle } },
  };
  return createAdapterService(ctx);
}
const withSettings = (settings) => ({ lobs: mapOpts().config.lobs, integrations: { claimsPort: { adapter: 'core-claims-suite', settings } } });

test('normaliseProfile maps tenant values to adapter profile ids', () => {
  for (const [v, p] of [['mapping-a', 'A'], ['mapping-b', 'B'], ['MAPPING-B', 'B'], ['Mapping-A', 'A'], ['a', 'A'], ['B', 'B'], [undefined, 'A']]) {
    assert.equal(normaliseProfile(v), p, String(v));
  }
});

test('aurelia-mutual and kestrel-point yield different mapped payloads', async () => {
  const aur = await svcFor(tenantFile('aurelia-mutual')).previewMapping('core-claims-suite', 'c1');
  const kes = await svcFor(tenantFile('kestrel-point')).previewMapping('core-claims-suite', 'c1');
  assert.equal(aur.profile, 'A');
  assert.equal(kes.profile, 'B');
  assert.ok(aur.payload.claimsNotificationAddRq);
  assert.equal(kes.payload.LOSS_DATE, '20261017');
  assert.notDeepEqual(aur.payload, kes.payload);
});

test('legacy settings.profile alias still works; fieldMapProfile wins', async () => {
  const alias = await svcFor(withSettings({ profile: 'B' })).previewMapping('core-claims-suite', 'c1');
  assert.equal(alias.profile, 'B');
  const both = await svcFor(withSettings({ fieldMapProfile: 'mapping-a', profile: 'B' })).previewMapping('core-claims-suite', 'c1');
  assert.equal(both.profile, 'A');
  const none = await svcFor(withSettings({})).previewMapping('core-claims-suite', 'c1');
  assert.equal(none.profile, 'A');
});

test('unsupported value gives 422 invalid_adapter_settings', async () => {
  await assert.rejects(
    svcFor(withSettings({ fieldMapProfile: 'mapping-z' })).previewMapping('core-claims-suite', 'c1'),
    (e) => e.status === 422 && e.code === 'invalid_adapter_settings',
  );
});
