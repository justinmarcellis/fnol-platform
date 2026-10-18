import { test, before, after } from 'node:test';
import { bootHarness, loadSynthetic } from './harness.mjs';
import { runMatrix } from './steps.mjs';

/**
 * E2E scenarios: scenario x tenant x lifecycle steps over HTTP. Missing modules/endpoints become t.todo.
 * Runs against the real tenants dir; with no tenants yet the whole matrix is a todo.
 */

let h;
let synthetic;

before(async () => {
  synthetic = await loadSynthetic();
  h = await bootHarness();
});

after(async () => {
  if (h) await h.close();
});

test('E2E scenario matrix', (t) => runMatrix(t, { h, synthetic }));
