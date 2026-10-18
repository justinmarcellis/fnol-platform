import { test } from 'node:test';
import assert from 'node:assert/strict';
import createClaude from '../../../../src/ai/providers/vertex-claude.mjs';
import createGemini from '../../../../src/ai/providers/vertex-gemini.mjs';
import { schemaFor } from '../../../../src/ai/schemas.mjs';

const env = { GOOGLE_CLOUD_PROJECT: 'demo-project' };
const reply = { output: { score: 40, band: 'medium', drivers: ['x'] }, confidence: 0.8, explanation: 'ok' };

function fakeAnthropic(response) {
  const calls = { ctor: [], create: [] };
  class AnthropicVertex {
    constructor(o) { calls.ctor.push(o); this.messages = { create: async (p) => { calls.create.push(p); return typeof response === 'function' ? response(p) : response; } }; }
  }
  return { AnthropicVertex, calls };
}

test('claude: request shape per tier, adaptive thinking, json_schema, no tool_choice/budget_tokens', async () => {
  const ok = { stop_reason: 'end_turn', model: 'claude-haiku-5-5', usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: JSON.stringify(reply) }] };
  const f = fakeAnthropic(ok);
  const p = createClaude({}, { sdk: f, env });
  assert.equal(p.name, 'vertex-claude');
  assert.equal(await p.available(), true);
  const expected = { cheap: 'claude-haiku-5-5', mid: 'claude-sonnet-5-5', strong: 'claude-opus-5-5' };
  for (const [tier, model] of Object.entries(expected)) {
    const r = await p.run('severity', { facts: {} }, { tier, schema: schemaFor('severity') });
    assert.deepEqual(r.output, reply.output);
    assert.equal(r.confidence, 0.8);
    assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(f.calls.create.at(-1).model, model);
  }
  assert.deepEqual(f.calls.ctor[0], { projectId: 'demo-project', region: 'global' });
  assert.equal(f.calls.ctor.length, 1);
  const params = f.calls.create[0];
  assert.deepEqual(params.thinking, { type: 'adaptive' });
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.equal(params.output_config.format.schema.properties.output.properties.band.type, 'string');
  assert.equal('tool_choice' in params, false);
  assert.ok(!JSON.stringify(params).includes('budget_tokens'));
});

test('claude: refusal checked before content is read', async () => {
  let touched = false;
  const res = { stop_reason: 'refusal', get content() { touched = true; return []; } };
  const p = createClaude({}, { sdk: fakeAnthropic(res), env });
  const r = await p.run('summarize', { facts: {} }, { tier: 'cheap' });
  assert.equal(r.refusal, true);
  assert.equal(touched, false);
});

test('claude: bad JSON and SDK errors become refusal, never throw', async () => {
  const bad = createClaude({}, { sdk: fakeAnthropic({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'nope' }] }), env });
  assert.equal((await bad.run('severity', {}, {})).refusal, true);
  const boom = createClaude({}, { sdk: fakeAnthropic(() => { throw new Error('503'); }), env });
  assert.equal((await boom.run('severity', {}, {})).refusal, true);
});

test('claude: unavailable without project; unavailable when SDK import fails', async () => {
  assert.equal(await createClaude({}, { sdk: fakeAnthropic({}), env: {} }).available(), false);
  const noRun = await createClaude({}, { sdk: fakeAnthropic({}), env: {} }).run('severity', {}, {});
  assert.equal(noRun.refusal, true);
  const brokenSdk = { get AnthropicVertex() { throw new Error('import failed'); } };
  assert.equal(await createClaude({}, { sdk: brokenSdk, env }).available(), false);
});

test('gemini: GoogleGenAI vertex init, responseSchema, tiers', async () => {
  const calls = { ctor: [], gen: [] };
  class GoogleGenAI {
    constructor(o) { calls.ctor.push(o); this.models = { generateContent: async (p) => { calls.gen.push(p); return { text: JSON.stringify(reply), usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } }; } }; }
  }
  const p = createGemini({}, { sdk: { GoogleGenAI }, env: { ...env, GOOGLE_CLOUD_LOCATION: 'us-central1' } });
  assert.equal(await p.available(), true);
  const r = await p.run('severity', { facts: {} }, { tier: 'strong', schema: schemaFor('severity') });
  assert.deepEqual(r.output, reply.output);
  assert.deepEqual(r.usage, { inputTokens: 7, outputTokens: 3 });
  assert.deepEqual(calls.ctor[0], { vertexai: true, project: 'demo-project', location: 'us-central1' });
  assert.equal(calls.gen[0].model, 'gemini-2.5-pro');
  assert.equal(calls.gen[0].config.responseMimeType, 'application/json');
  assert.equal(calls.gen[0].config.responseSchema.type, 'OBJECT');
  await p.run('severity', {}, { tier: 'cheap' });
  assert.equal(calls.gen[1].model, 'gemini-2.5-flash');
});

test('gemini: location defaults to global; missing project or failed import is unavailable', async () => {
  const seen = [];
  class G { constructor(o) { seen.push(o); this.models = {}; } }
  await createGemini({}, { sdk: { GoogleGenAI: G }, env }).available();
  assert.equal(seen[0].location, 'global');
  assert.equal(await createGemini({}, { sdk: { GoogleGenAI: G }, env: {} }).available(), false);
  assert.equal(await createGemini({}, { sdk: { get GoogleGenAI() { throw new Error('x'); } }, env }).available(), false);
});

test('gemini: safety block is a refusal; errors do not throw', async () => {
  class G { constructor() { this.models = { generateContent: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }) }; } }
  assert.equal((await createGemini({}, { sdk: { GoogleGenAI: G }, env }).run('severity', {}, {})).refusal, true);
  class H { constructor() { this.models = { generateContent: async () => { throw new Error('x'); } }; } }
  assert.equal((await createGemini({}, { sdk: { GoogleGenAI: H }, env }).run('severity', {}, {})).refusal, true);
});

test('real SDK import path: no project means unavailable without throwing', async () => {
  assert.equal(await createClaude({}, { env: {} }).available(), false);
  assert.equal(await createGemini({}, { env: {} }).available(), false);
});
