import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NotImplemented, requireImplemented, runStep, bootHarness, loadSynthetic, scenarioAppliesTo,
  scenarioList, compareExpected,
} from './harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMatrix } from './steps.mjs';

test('requireImplemented maps 404 and 501 to NotImplemented', () => {
  assert.throws(() => requireImplemented({ status: 404 }, 'GET /x'), NotImplemented);
  assert.throws(() => requireImplemented({ status: 501 }, 'GET /x'), NotImplemented);
  assert.equal(requireImplemented({ status: 200 }, 'GET /x').status, 200);
  assert.equal(requireImplemented({ status: 500 }, 'GET /x').status, 500);
});

test('runStep turns NotImplemented into t.todo with the reason, and rethrows real failures', async () => {
  const todos = [];
  const fakeT = { todo: (m) => todos.push(m) };
  assert.equal(await runStep(fakeT, async () => { throw new NotImplemented('no module'); }), false);
  assert.deepEqual(todos, ['no module']);
  assert.equal(await runStep(fakeT, async () => {}), true);
  await assert.rejects(runStep(fakeT, async () => assert.equal(1, 2)), assert.AssertionError);
  await assert.rejects(runStep(fakeT, async () => { throw new TypeError('boom'); }), TypeError);
  assert.equal(todos.length, 1);
});

test('compareExpected checks only produced keys and supports any-of arrays', () => {
  compareExpected({ severityBand: ['minor', 'moderate'], fastTrack: true }, { severityBand: 'minor' });
  compareExpected({ fraud: false }, {});
  assert.throws(() => compareExpected({ fastTrack: true }, { fastTrack: false }), assert.AssertionError);
  assert.throws(() => compareExpected({ severityBand: ['minor'] }, { severityBand: 'severe' }), assert.AssertionError);
});

test('scenarioAppliesTo and scenarioList', () => {
  assert.equal(scenarioAppliesTo({}, 'homeowners'), true);
  assert.equal(scenarioAppliesTo({ lobs: ['personal_auto'] }, 'homeowners'), false);
  assert.equal(scenarioAppliesTo({ lobs: [{ id: 'homeowners' }] }, 'homeowners'), true);
  assert.deepEqual(scenarioList(['auto']), [{ name: 'auto', lob: 'auto' }]);
  assert.deepEqual(scenarioList([{ name: 'a', lob: 'x' }]), [{ name: 'a', lob: 'x' }]);
});

test('synthetic loader returns a usable contract (real or fallback)', async () => {
  const s = await loadSynthetic();
  assert.ok(s.source);
  const list = scenarioList(s.SCENARIOS);
  assert.ok(list.length >= 1);
  const sc = s.generateScenario(list[0].name, { seed: 'seed', tenantId: 'northwind' });
  for (const k of ['name', 'lob', 'lossType', 'intakeAnswers', 'claimCreate', 'documents', 'expected']) assert.ok(k in sc, `scenario.${k}`);
  const pol = { tenantId: 'northwind', lob: list[0].lob, count: 3, seed: 'x' };
  assert.deepEqual(s.generatePolicies(pol), s.generatePolicies(pol));
});

test('harness boots createApp on port 0 against the real tenants dir and closes cleanly', async () => {
  const h = await bootHarness();
  try {
    assert.ok(h.app.port > 0);
    const res = await fetch(`${h.app.url}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  } finally {
    await h.close();
  }
});

test('matrix with a temp tenant: missing modules map to todo and nothing fails', async (t) => {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-e2e-tenants-'));
  fs.writeFileSync(path.join(tdir, 'e2e-demo.json'), JSON.stringify({ id: 'e2e-demo', displayName: 'E2E Demo Mutual (fictional)' }));
  const h = await bootHarness({ tenantsDir: tdir });
  try {
    const synthetic = await loadSynthetic();
    await runMatrix(t, { h, synthetic, tenants: [{ id: 'e2e-demo', config: {} }] });
  } finally {
    await h.close();
    fs.rmSync(tdir, { recursive: true, force: true });
  }
});

test('local fallback fake honours the same contract as tests/synthetic', async () => {
  const f = await import('./fakes/synthetic-fallback.mjs');
  const list = scenarioList(f.SCENARIOS);
  assert.equal(list.length, 2);
  for (const e of list) {
    const sc = f.generateScenario(e.name, { seed: 's', tenantId: 'northwind' });
    for (const k of ['name', 'lob', 'lossType', 'intakeAnswers', 'claimCreate', 'documents', 'expected']) assert.ok(k in sc, `scenario.${k}`);
    assert.deepEqual(sc, f.generateScenario(e.name, { seed: 's', tenantId: 'northwind' }));
  }
  assert.throws(() => f.generateScenario('nope'), /unknown scenario/);
});
