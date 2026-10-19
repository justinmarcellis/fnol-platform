import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateTenantConfig } from '../../../src/modules/config/service.js';

const load = (n) => JSON.parse(fs.readFileSync(new URL(`../../../tenants/${n}.json`, import.meta.url), 'utf8'));
const A = load('aurelia-mutual');
const K = load('kestrel-point');
const rules = { validateRules: () => ({ valid: true, errors: [] }) };

for (const [name, cfg] of [['aurelia-mutual', A], ['kestrel-point', K]]) {
  test(`${name} validates (schema and semantics)`, () => {
    const r = validateTenantConfig(cfg, { rules });
    assert.equal(r.valid, true, JSON.stringify(r.errors, null, 1));
    assert.equal(cfg.tenantId, name);
  });

  test(`${name}: 4+ queues with 2-3 adjusters each, timers illustrative, webhooks, local-first AI cascade`, () => {
    assert.ok(cfg.queues.length >= 4);
    for (const q of cfg.queues) assert.ok(q.adjusters.length >= 2 && q.adjusters.length <= 3, q.id);
    for (const t of cfg.timers) assert.match(t.citation, /Illustrative, not legal advice/);
    assert.equal(cfg.notifications.webhooks.enabled, true);
    assert.equal(cfg.notifications.webhooks.includePii, false);
    assert.equal(cfg.ai.cascade[0].provider, 'local');
  });

  test(`${name}: synthetic only (fictional markers, example domains, no secrets)`, () => {
    const text = JSON.stringify(cfg);
    assert.match(cfg.displayName, /fictional/);
    for (const email of text.match(/[\w.-]+@[\w.-]+/g) ?? []) assert.match(email, /\.example$/);
    assert.doesNotMatch(text, /password|secret|api[_-]?key|BEGIN [A-Z ]*KEY/i);
  });
}

test('Aurelia: personal auto + homeowners, WI+IL, en+es, aggressive STP', () => {
  assert.deepEqual(A.lobs.map((l) => l.id), ['personal_auto', 'homeowners']);
  assert.deepEqual([...new Set(A.lobs.flatMap((l) => l.states))].sort(), ['IL', 'WI']);
  assert.deepEqual(A.locales, ['en', 'es']);
  assert.equal(A.fastTrack.maxEstimate.amount, 2500);
  const ids = A.rules.map((r) => r.id);
  assert.ok(ids.includes('RT-FT-GLASS') && ids.includes('RT-FT-HOME-SMALL'));
});

test('Kestrel: personal auto + commercial auto, MI only, en only, glass-only STP, stricter SIU', () => {
  assert.deepEqual(K.lobs.map((l) => l.id), ['personal_auto', 'commercial_auto']);
  assert.deepEqual([...new Set(K.lobs.flatMap((l) => l.states))], ['MI']);
  assert.deepEqual(K.locales, ['en']);
  const stp = K.rules.filter((r) => r.then.some((a) => a.type === 'fast_track'));
  assert.deepEqual(stp.map((r) => r.id), ['RT-FT-GLASS']);
  const siu = (c) => c.rules.find((r) => r.id === 'RT-SIU-01').when.value;
  assert.ok(siu(K) < siu(A), 'Kestrel SIU threshold is stricter');
  const ca = K.questionSets.find((s) => s.lob === 'commercial_auto').questions.map((q) => q.id);
  for (const id of ['unit_number', 'driver_is_employee', 'cargo_involved', 'hazmat_involved', 'dot_recordable']) assert.ok(ca.includes(id), id);
});

test('tenants differ materially in branding, LOBs, states, locales, STP, SIU, queues, timers', () => {
  const j = JSON.stringify;
  assert.notEqual(A.branding.primaryColor, K.branding.primaryColor);
  assert.notEqual(j(A.lobs.map((l) => l.id)), j(K.lobs.map((l) => l.id)));
  assert.notEqual(j(A.locales), j(K.locales));
  assert.notEqual(j(A.fastTrack), j(K.fastTrack));
  assert.notEqual(j(A.queues.map((q) => q.id)), j(K.queues.map((q) => q.id)));
  assert.notEqual(j(A.timers.map((t) => t.id)), j(K.timers.map((t) => t.id)));
  assert.notEqual(j(A.integrations), j(K.integrations));
  assert.equal(A.ai.tasks.next_question.enabled, true);
  assert.equal(K.ai.tasks.next_question.enabled, false);
});

test('the same loss yields different question sets per tenant', () => {
  const sets = (c) => c.questionSets.filter((s) => s.lob === 'personal_auto' && (!s.lossTypes || s.lossTypes.includes('glass')));
  const qa = sets(A).flatMap((s) => s.questions.map((q) => q.id));
  const qk = sets(K).flatMap((s) => s.questions.map((q) => q.id));
  assert.notDeepEqual(qa.sort(), qk.sort());
});
