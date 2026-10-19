// POST /claims follows ClaimCreate (additionalProperties:false, no `answers`): unknown properties are a 400, never silently dropped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootClaimsApp, call, claimInput } from './helpers.mjs';

let app;
let csr;
const URL = '/api/v1/claims';

before(async () => { app = await bootClaimsApp(); csr = app.token(['csr'], 'alpha', 'csr-1'); });
after(async () => { await app.close(); });

const count = async () => (await call(app, 'GET', URL, { token: csr })).json.items.length;

test('answers on POST /claims is rejected with 400 and the error envelope; no claim is created', async () => {
  const before = await count();
  const r = await call(app, 'POST', URL, { token: csr, body: claimInput({ answers: { drivable: true, injuries: false } }) });
  assert.equal(r.status, 400, r.text);
  assert.ok(r.json?.error ?? r.json?.code, 'standard error envelope');
  assert.match(r.text, /answers/);
  assert.equal(await count(), before);
});

test('every unknown property is named, and server-only fields cannot be smuggled in', async () => {
  const r = await call(app, 'POST', URL, { token: csr, body: claimInput({ intakeSessionId: 'ins_x', status: 'closed' }) });
  assert.equal(r.status, 400, r.text);
  assert.match(r.text, /intakeSessionId/);
  assert.match(r.text, /status/);
});

test('a non-object body is a 400', async () => {
  const r = await call(app, 'POST', URL, { token: csr, body: [claimInput()] });
  assert.equal(r.status, 400, r.text);
});

test('a body with only ClaimCreate properties is still created', async () => {
  const r = await call(app, 'POST', URL, { token: csr, body: claimInput({ externalRef: { system: 'synthetic', id: 'x-1' } }) });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.lob, 'personal_auto');
  assert.equal('answers' in r.json, false);
});
