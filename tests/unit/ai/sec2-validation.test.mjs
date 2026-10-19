// S5-AI-01 / SEC2-009: model outputs are schema-validated before acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../../src/core/store.mjs';
import { createAi } from '../../../src/ai/index.mjs';
import { validateOutput } from '../../../src/ai/guardrails.mjs';
import { AppError } from '../../../src/core/errors.mjs';

const GOOD = { severity: { score: 40, band: 'medium', drivers: ['x'] }, summarize: { summary: 's', bullets: ['a'] } };
const prov = (output, confidence = 0.99) => ({ async available() { return true; }, async run() { return { output, confidence, explanation: 'x' }; } });
function setup(providers) {
  const ctx = { db: createStore(':memory:'), AppError, tenants: { get: () => ({ ai: { provider: 'local' } }) }, clock: { nowIso: () => '2026-01-01T00:00:00Z' } };
  return createAi(ctx, { providers });
}
const rejected = async (task, output, conf) => {
  const ai = setup({ local: prov(output, conf) });
  try { await ai.run(task, {}, { tenantId: 't1' }); return false; } catch (e) { assert.equal(e.code, 'ai_unavailable'); return true; }
};

test('wrong types, enums, ranges, lengths and item types are invalid_output', async () => {
  assert.ok(await rejected('severity', { score: 'DROP', band: { x: 1 }, drivers: 'not-an-array' }));
  assert.ok(await rejected('severity', { score: 1e9, band: 'high', drivers: [] }));
  assert.ok(await rejected('severity', { score: 10, band: 'high', drivers: [1, 2] }));
  assert.ok(await rejected('severity', { score: NaN, band: 'high', drivers: [] }));
  assert.ok(await rejected('summarize', { summary: 'x'.repeat(5000), bullets: [] }));
  assert.ok(await rejected('summarize', { summary: 's', bullets: Array(200).fill('b') }));
  assert.ok(await rejected('extract_narrative', { lossType: 'c', lossDate: 'd', location: 'l', injuries: 'yes', injuryCues: [], atFault: 'me', cues: [] }));
  assert.ok(await rejected('severity', GOOD.severity, 7)); // confidence out of range
});

test('the adjuster summary shape {summary:{}, bullets:"abc"} is refused', async () => {
  assert.ok(await rejected('summarize', { summary: {}, bullets: 'abc' }));
});

test('invalid output falls through the cascade to the next provider', async () => {
  const cfg = { ai: { provider: 'cascade', cascade: [{ provider: 'vertex-gemini', model: 'g' }, { provider: 'local' }] } };
  const ctx = { db: createStore(':memory:'), AppError, tenants: { get: () => cfg }, clock: { nowIso: () => '' } };
  const ai = createAi(ctx, { providers: { 'vertex-gemini': prov({ summary: {}, bullets: 'abc' }), local: prov(GOOD.summarize, 0.9) } });
  const r = await ai.run('summarize', {}, { tenantId: 't1' });
  assert.equal(r.provider, 'local');
  assert.deepEqual(r.escalatedFrom, ['vertex-gemini']);
});

test('valid outputs are accepted and validateOutput reports length caps', async () => {
  const ai = setup({ local: prov(GOOD.severity, 0.9) });
  assert.deepEqual((await ai.run('severity', {}, { tenantId: 't1' })).output, GOOD.severity);
  assert.equal(validateOutput('summarize', { summary: 'x'.repeat(4001), bullets: [] }).valid, false);
  assert.equal(validateOutput('summarize', GOOD.summarize).valid, true);
});
