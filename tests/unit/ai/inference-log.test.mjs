import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../../src/core/store.mjs';
import { createAi } from '../../../src/ai/index.mjs';
import { createInferenceLog, hashInput } from '../../../src/ai/inference-log.mjs';
import { AppError } from '../../../src/core/errors.mjs';

const RAW = 'Jane Fictional hit a tree at 12 Elm Street';
const provider = {
  name: 'local', available: async () => true,
  run: async () => ({ output: { summary: 'x', bullets: [] }, confidence: 0.9, explanation: 'e', usage: { tokens: 5 }, model: 'local-v1' }),
};
function setup() {
  const db = createStore(':memory:');
  const ctx = { db, AppError, tenants: { get: () => ({ ai: { provider: 'local' } }) } };
  return { db, ctx, ai: createAi(ctx, { providers: { local: provider } }) };
}

test('table is created idempotently and registered as a tenant table', () => {
  const { db, ctx } = setup();
  createInferenceLog(ctx);
  createInferenceLog(ctx);
  assert.ok(db.isTenantTable('ai_inference'));
});

test('rows are tenant scoped, hashed, and hold no raw input text', async () => {
  const { db, ai } = setup();
  await ai.run('summarize', { text: RAW }, { tenantId: 'a' });
  await ai.run('summarize', { text: 'other' }, { tenantId: 'b' });
  const a = ai.log.list('a');
  const b = ai.log.list('b');
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].input_hash, hashInput({ text: RAW }));
  assert.match(a[0].input_hash, /^[0-9a-f]{64}$/);
  assert.equal(a[0].provider, 'local');
  assert.equal(a[0].model, 'local-v1');
  assert.equal(a[0].confidence, 0.9);
  assert.deepEqual(a[0].usage, { tokens: 5 });
  const dump = JSON.stringify(db.raw.prepare('SELECT * FROM ai_inference').all());
  assert.ok(!dump.includes('Jane') && !dump.includes('Elm Street'));
  assert.equal(db.forTenant('a').all('SELECT * FROM ai_inference').length, 1);
});

test('hash is key-order independent; record never throws', () => {
  assert.equal(hashInput({ a: 1, b: 2 }), hashInput({ b: 2, a: 1 }));
  const { ctx } = setup();
  const log = createInferenceLog(ctx);
  assert.equal(log.record(null, { task: 't', input: {} }), null);
});

test('no /ai/inferences route is registered by the ai layer', () => {
  const { ai } = setup();
  assert.equal(ai.routes, undefined);
});
