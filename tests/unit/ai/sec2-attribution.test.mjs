// S5-AI-01 / SEC2-010: every AI call is attributed to a tenant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../../../src/core/store.mjs';
import { createAi } from '../../../src/ai/index.mjs';
import { AppError } from '../../../src/core/errors.mjs';

const ok = { async available() { return true; }, async run() { return { output: { summary: 's', bullets: [] }, confidence: 0.9, explanation: 'x' }; } };
function setup() {
  const ctx = { db: createStore(':memory:'), AppError, tenants: { get: () => ({ ai: { provider: 'local' } }) }, clock: { nowIso: () => '' } };
  return { ctx, ai: createAi(ctx, { providers: { local: ok } }) };
}

test('ai.run without a tenant throws a typed error', async () => {
  const { ai } = setup();
  await assert.rejects(() => ai.run('summarize', {}), (e) => e.code === 'ai_tenant_required');
  await assert.rejects(() => ai.run('summarize', {}, {}), (e) => e.code === 'ai_tenant_required');
});

test('tenantId option, forTenant and the tenant-bound ctx attribute the call and log it', async () => {
  const { ctx, ai } = setup();
  await ai.run('summarize', {}, { tenantId: 't1' });
  await ai.forTenant('t1').run('summarize', {});
  const tctx = Object.create(ctx); tctx.tenant = { id: 't1' }; // what ctx.forTenant builds
  await tctx.ai.run('summarize', {});
  assert.equal(ai.log.list('t1').length, 3);
  await assert.rejects(() => ctx.ai.run('summarize', {}), (e) => e.code === 'ai_tenant_required');
});

function callText(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(from, i + 1);
  }
  return src.slice(from);
}
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('every ai.run( caller in src/ passes tenantId or uses forTenant', () => {
  const root = path.resolve(import.meta.dirname, '../../../src');
  const bad = [];
  let seen = 0;
  for (const f of walk(root)) {
    if (f.includes(`${path.sep}src${path.sep}ai${path.sep}`)) continue; // the AI layer itself
    const src = fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/\bai\.run\(/g)) {
      seen++;
      const text = callText(src, m.index + m[0].length - 1);
      const before = src.slice(Math.max(0, m.index - 80), m.index);
      if (!/tenantId/.test(text) && !/forTenant\([^)]*\)\.$/.test(before)) bad.push(`${path.relative(root, f)}: ${text.slice(0, 60)}`);
    }
  }
  assert.ok(seen >= 4, 'expected to find the module callers');
  assert.deepEqual(bad, []);
});

test('intake conversation uses the keyword fallback on an unbound ctx and the tenant on a bound one', async () => {
  const { suggestFromNarrative } = await import('../../../src/modules/intake/conversation.js');
  const calls = [];
  const mk = (tenant) => ({ clock: { nowIso: () => '2026-10-01T00:00:00Z' }, tenant, ai: { async run(t, i, o) { calls.push(o); throw new Error('x'); } } });
  const q = [{ id: 'loss_type' }];
  await suggestFromNarrative(mk(undefined), 'a windshield crack', { questions: q });
  assert.equal(calls.length, 0);
  await suggestFromNarrative(mk({ id: 't1' }), 'a windshield crack', { questions: q });
  assert.equal(calls[0].tenantId, 't1');
});
