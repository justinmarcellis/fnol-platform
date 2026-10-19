import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../../src/core/store.mjs';
import { createAi } from '../../../src/ai/index.mjs';
import { resolveChain, hardFlags } from '../../../src/ai/cascade.mjs';
import { AppError } from '../../../src/core/errors.mjs';

const out = { summary: 's', bullets: [] };
function fake(name, { confidence = 0.9, available = true, throws = false, refusal = false, output = out } = {}) {
  const calls = [];
  return {
    calls, name,
    available: async () => available,
    async run(task, input, o) {
      calls.push({ task, tier: o.tier, model: o.model });
      if (throws) throw new Error('boom');
      if (refusal) return { refusal: true };
      return { output, confidence, explanation: `${name} ok`, usage: { in: 1, out: 1 }, model: `${name}-m` };
    },
  };
}
function setup(ai, providers) {
  const db = createStore(':memory:');
  const ctx = { db, AppError, tenants: { get: (id) => (id === 't1' ? { ai } : null) }, clock: { nowIso: () => '2026-01-01T00:00:00Z' } };
  return { ctx, ai: createAi(ctx, { providers }) };
}
const cascadeCfg = {
  provider: 'cascade',
  cascade: [
    { provider: 'local', minConfidence: 0.75 },
    { provider: 'vertex-gemini', model: 'gemini-flash', minConfidence: 0.7 },
    { provider: 'vertex-claude', model: 'claude-opus', minConfidence: 0.6 },
  ],
  tasks: { summarize: { threshold: 0.8 } },
};

test('accepts first provider when confidence clears threshold', async () => {
  const p = { local: fake('local', { confidence: 0.9 }), 'vertex-gemini': fake('vertex-gemini'), 'vertex-claude': fake('vertex-claude') };
  const { ai } = setup(cascadeCfg, p);
  const r = await ai.run('summarize', { facts: {} }, { tenantId: 't1' });
  assert.equal(r.provider, 'local');
  assert.equal(r.unconfirmed, undefined);
  assert.equal(p['vertex-gemini'].calls.length, 0);
  for (const k of ['output', 'provider', 'model', 'confidence', 'explanation', 'usage']) assert.ok(k in r);
});

test('per-task threshold escalates to next provider', async () => {
  const p = { local: fake('local', { confidence: 0.78, output: out }), 'vertex-gemini': fake('vertex-gemini', { confidence: 0.85 }), 'vertex-claude': fake('vertex-claude') };
  const { ai } = setup(cascadeCfg, p);
  // summarize: task threshold .8 -> local .78 escalates to gemini .85
  const r = await ai.run('summarize', { facts: {} }, { tenantId: 't1' });
  assert.equal(r.provider, 'vertex-gemini');
  assert.deepEqual(r.escalatedFrom, ['local']);
});

test('hard escalation skips cheap tier and goes to strong tier, then local last', async () => {
  const p = { local: fake('local'), 'vertex-gemini': fake('vertex-gemini'), 'vertex-claude': fake('vertex-claude', { confidence: 0.95 }) };
  const { ai } = setup(cascadeCfg, p);
  for (const facts of [{ injuries: true }, { fatality: true }, { litigation: true }, { catCode: 'CAT-12' }]) {
    const r = await ai.run('summarize', { facts }, { tenantId: 't1' });
    assert.equal(r.provider, 'vertex-claude', JSON.stringify(facts));
  }
  assert.equal(p.local.calls.length, 0);
  assert.equal(p['vertex-gemini'].calls.length, 0);
  assert.deepEqual(hardFlags({ facts: { injuries: false } }), []);
});

test('refusal, throw and unavailable fall through; always ends on local', async () => {
  const p = { local: fake('local', { confidence: 0.1 }), 'vertex-gemini': fake('vertex-gemini', { refusal: true }), 'vertex-claude': fake('vertex-claude', { throws: true }) };
  const { ai } = setup(cascadeCfg, p);
  const r = await ai.run('summarize', { facts: {} }, { tenantId: 't1' });
  assert.equal(r.provider, 'local');
  assert.equal(r.unconfirmed, true);

  const p2 = { local: fake('local', { confidence: 0.9 }), 'vertex-gemini': fake('vertex-gemini', { available: false }), 'vertex-claude': fake('vertex-claude', { available: false }) };
  const { ai: ai2 } = setup({ ...cascadeCfg, cascade: cascadeCfg.cascade.slice(1) }, p2);
  const r2 = await ai2.run('summarize', { facts: { injuries: true } }, { tenantId: 't1' });
  assert.equal(r2.provider, 'local');
  assert.equal(r2.unconfirmed, undefined);
});

test('single provider config, default config and local append', async () => {
  const chain = resolveChain({ provider: 'vertex-claude' }, 'severity');
  assert.deepEqual(chain.map((e) => e.provider), ['vertex-claude', 'local']);
  assert.deepEqual(resolveChain(undefined, 'severity').map((e) => e.provider), ['local']);
  assert.deepEqual(resolveChain({ provider: 'cascade', cascade: cascadeCfg.cascade, tasks: { severity: { enabled: false } } }, 'severity').map((e) => e.provider), ['local']);
  const p = { local: fake('local', { confidence: 0.9 }) };
  const { ai } = setup(undefined, p);
  assert.equal((await ai.run('summarize', {}, { tenantId: 'nope' })).provider, 'local');
});

test('entry task filter and no providers at all', async () => {
  const cfg = { provider: 'cascade', cascade: [{ provider: 'vertex-claude', tasks: ['summarize'] }] };
  assert.deepEqual(resolveChain(cfg, 'severity').map((e) => e.provider), ['local']);
  const { ai } = setup(cfg, { local: fake('local', { available: false }) });
  await assert.rejects(() => ai.run('summarize', {}, { tenantId: 't1' }), (e) => e.code === 'ai_unavailable');
});

test('unknown task throws validation error', async () => {
  const { ai } = setup(undefined, { local: fake('local') });
  await assert.rejects(() => ai.run('make_coffee', {}, { tenantId: 't1' }), (e) => e.code === 'validation_error' && e.status === 400);
});

test('invalid provider output falls through; per-call providers override', async () => {
  const bad = fake('local', { output: { nope: 1 } });
  const { ai } = setup(undefined, { local: bad });
  await assert.rejects(() => ai.run('summarize', {}, { tenantId: 't1' }));
  const good = fake('local');
  const r = await ai.run('summarize', {}, { tenantId: 't1', providers: { local: good } });
  assert.equal(r.model, 'local-m');
});

test('runs without any provider files present (lazy load tolerant)', async () => {
  const { ai } = setup(undefined, undefined);
  try { await ai.run('summarize', { facts: {} }, { tenantId: 't1' }); } catch (e) { assert.equal(e.code, 'ai_unavailable'); }
  assert.ok(['available', 'unconfigured'].includes((await ai.health()).local));
});
