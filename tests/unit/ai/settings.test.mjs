import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../../src/core/store.mjs';
import { createAi } from '../../../src/ai/index.mjs';
import { guard } from '../../../src/ai/guardrails.mjs';
import { AppError } from '../../../src/core/errors.mjs';

const out = { summary: 's', bullets: [] };
function fake(name, { confidence = 0.9, tokens = 0, kind } = {}) {
  const calls = [];
  return {
    calls, name, ...(kind ? { kind } : {}),
    available: async () => true,
    async run(task, input) {
      calls.push(JSON.stringify(input));
      return { output: out, confidence, explanation: '', usage: { inputTokens: tokens, outputTokens: 0 }, model: `${name}-m` };
    },
  };
}
const cfgs = {};
function setup(providers) {
  const db = createStore(':memory:');
  const ctx = { db, AppError, tenants: { get: (id) => cfgs[id] ?? null }, clock: { nowIso: () => '2026-01-01T00:00:00Z' } };
  return createAi(ctx, { providers });
}
const cascade = (extra) => ({ provider: 'cascade', cascade: [{ provider: 'vertex-gemini', model: 'flash', minConfidence: 0.7 }, { provider: 'local' }], ...extra });
const input = { facts: { claimantName: 'Zed Quill', note: 'call 555-123-4567' } };

test('humanConfirmRequired marks every result, including early returns', async () => {
  cfgs.a = { ai: cascade({ humanConfirmRequired: true }) };
  cfgs.b = { ai: cascade({ humanConfirmRequired: false }) };
  cfgs.c = { ai: cascade() };
  const mk = () => ({ 'vertex-gemini': fake('vertex-gemini'), local: fake('local') });
  const ai = setup(mk());
  assert.equal((await ai.run('summarize', input, { tenantId: 'a' })).unconfirmed, true);
  assert.equal((await ai.run('summarize', input, { tenantId: 'b' })).unconfirmed, undefined);
  assert.equal((await ai.run('summarize', input, { tenantId: 'c' })).unconfirmed, undefined);
});

test('redactPiiBeforeModel: explicit true redacts unguarded and local; guard forceRedact', async () => {
  cfgs.r = { ai: { provider: 'local', redactPiiBeforeModel: true } };
  cfgs.n = { ai: { provider: 'local', redactPiiBeforeModel: false } };
  const local = fake('local');
  const ai = setup({ local });
  await ai.run('summarize', input, { tenantId: 'r' });
  assert.ok(!local.calls[0].includes('Zed Quill') && !local.calls[0].includes('555-123-4567'));
  await ai.run('summarize', input, { tenantId: 'n' });
  assert.ok(local.calls[1].includes('Zed Quill'));

  const inner = fake('local');
  const plain = guard(inner);
  await plain.run('summarize', input, {});
  assert.ok(inner.calls[0].includes('Zed Quill'));
  await guard(inner, { forceRedact: true }).run('summarize', input, {});
  assert.ok(!inner.calls[1].includes('Zed Quill'));
  await plain.run('summarize', input, { forceRedact: true });
  assert.ok(!inner.calls[2].includes('Zed Quill'));
});

test('cloud providers are redacted by guard even when setting is false', async () => {
  const inner = fake('vertex-gemini', { kind: 'cloud' });
  const g = guard(inner);
  await g.run('summarize', input, { forceRedact: false });
  assert.ok(!inner.calls[0].includes('Zed Quill'));
});

test('maxTokensPerClaim skips cloud, falls back to local, unconfirmed; isolated per tenant', async () => {
  cfgs.t1 = { ai: cascade({ maxTokensPerClaim: 100 }) };
  cfgs.t2 = { ai: cascade({ maxTokensPerClaim: 100 }) };
  const gem = fake('vertex-gemini', { confidence: 0.95, tokens: 150 });
  const local = fake('local', { confidence: 0.9 });
  const ai = setup({ 'vertex-gemini': gem, local });
  const r1 = await ai.run('summarize', input, { tenantId: 't1', claimId: 'C1' });
  assert.equal(r1.provider, 'vertex-gemini');
  assert.equal(r1.unconfirmed, undefined);
  assert.equal(ai.log.tokensForClaim('t1', 'C1'), 150);
  const r2 = await ai.run('summarize', input, { tenantId: 't1', claimId: 'C1' });
  assert.equal(r2.provider, 'local');
  assert.equal(r2.unconfirmed, true);
  assert.equal(gem.calls.length, 1);
  assert.ok(ai.log.list('t1').some((x) => x.usage?.skipped === 'budget'));
  // other claim, and other tenant, unaffected
  assert.equal((await ai.run('summarize', input, { tenantId: 't1', claimId: 'C2' })).provider, 'vertex-gemini');
  assert.equal(ai.log.tokensForClaim('t2', 'C1'), 0);
  assert.equal((await ai.run('summarize', input, { tenantId: 't2', claimId: 'C1' })).provider, 'vertex-gemini');
});
