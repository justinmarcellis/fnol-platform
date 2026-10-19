import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed, devUsersFor } from '../../../scripts/seed.mjs';

function fakes({ coverage = true, tenants = ['t1', 't2'] } = {}) {
  const state = { closed: 0, appOpts: null, seeded: [], gen: [] };
  const configs = { t1: { lobs: [{ id: 'personal_auto', enabled: true, states: ['WI'] }, { id: 'homeowners', enabled: false, states: ['WI'] }] }, t2: { lobs: [{ id: 'homeowners', states: ['MI', 'IL'] }] } };
  const createApp = async (o) => {
    state.appOpts = o;
    return {
      close: async () => { state.closed++; },
      ctx: {
        tenants: { list: () => tenants, get: (id) => configs[id] },
        auth: { issueToken: ({ sub, tenantId, roles }) => `tok.${tenantId}.${sub}.${roles[0]}` },
        forTenant: (id) => ({ modules: coverage ? { coverage: { seedPolicies: async (p) => { state.seeded.push([id, p.length]); return { inserted: p.length }; } } } : {} }),
      },
    };
  };
  const importSynthetic = async () => ({ generatePolicies: (a) => { state.gen.push(a); return Array.from({ length: a.count }, (_, i) => ({ policyNumber: `P${i}` })); } });
  return { state, createApp, importSynthetic };
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seed-')), 'sub', 'dev-users.json');
const quiet = () => {};

test('seeds enabled LOBs with the specified generator args and closes', async () => {
  const f = fakes(); const devUsersPath = tmp();
  const r = await seed({ ...f, devUsersPath, log: quiet });
  assert.equal(f.state.appOpts.port, 0);
  assert.equal(f.state.closed, 1);
  assert.deepEqual(f.state.gen, [
    { tenantId: 't1', lob: 'personal_auto', count: 25, seed: 42, state: 'WI' },
    { tenantId: 't2', lob: 'homeowners', count: 25, seed: 42, state: 'MI' },
  ]);
  assert.equal(r.seeded.length, 2);
  const file = JSON.parse(fs.readFileSync(devUsersPath, 'utf8'));
  assert.equal(file.users.length, 2 * devUsersFor('x').length);
  assert.ok(!JSON.stringify(file).includes('tok.'));
  assert.ok(r.tokens.every((t) => t.token.startsWith('tok.')));
});

test('skips gracefully when synthetic module is missing', async () => {
  const f = fakes();
  const r = await seed({ ...f, importSynthetic: async () => { throw new Error('nope'); }, devUsersPath: tmp(), log: quiet });
  assert.equal(f.state.seeded.length, 0);
  assert.ok(r.skipped.includes('synthetic'));
  assert.equal(r.users.length > 0, true);
  assert.equal(f.state.closed, 1);
});

test('skips when coverage service is missing', async () => {
  const f = fakes({ coverage: false });
  const r = await seed({ ...f, devUsersPath: tmp(), log: quiet });
  assert.equal(f.state.gen.length, 0);
  assert.deepEqual(r.skipped, ['t1/personal_auto', 't2/homeowners']);
});

test('idempotent: second run yields identical output file', async () => {
  const f = fakes(); const devUsersPath = tmp();
  await seed({ ...f, devUsersPath, log: quiet });
  const a = fs.readFileSync(devUsersPath, 'utf8');
  await seed({ ...f, devUsersPath, log: quiet });
  assert.equal(fs.readFileSync(devUsersPath, 'utf8'), a);
  assert.equal(f.state.closed, 2);
});

test('closes the app even when seeding throws', async () => {
  const f = fakes();
  const r = await seed({ ...f, importSynthetic: async () => ({ generatePolicies: () => { throw new Error('boom'); } }), devUsersPath: tmp(), log: quiet });
  assert.equal(f.state.closed, 1);
  assert.equal(r.seeded.length, 0);
});
