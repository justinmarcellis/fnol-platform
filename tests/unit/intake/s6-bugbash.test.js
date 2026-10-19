// S6-BUG-05 regressions for intake: state-specific fraud notice (CSR-16, CLAIMANT-9), commercial holder check (CLAIMANT-8),
// conditional requiredness on the wire (CSR-14), accented Spanish messages (CLAIMANT-13) and the named insured on submit (DATA-1).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntakeApp, call, sampleTenant } from './helpers.mjs';
import { reset, snapshots, store } from './fakes.mjs';
import { publicQuestion, validateAnswer } from '../../../src/modules/intake/questions.js';
import { enrichClaimCreate } from '../../../src/modules/intake/mapping.js';

const base = '/api/v1/intake/sessions';
const t = (en, es) => ({ en, es });
function tenant() {
  const cfg = sampleTenant('tn-one');
  cfg.branding.fraudWarning = { WI: t('Notice (WI)', 'Aviso (WI)'), IL: t('Notice (IL)', 'Aviso (IL)') };
  return cfg;
}
let app;
const tok = (roles, sub = 'c1') => app.ctx.auth.issueToken({ sub, tenantId: 'tn-one', roles });
before(async () => { app = await bootIntakeApp({ tenants: [tenant(), sampleTenant('tn-two')] }); });
after(async () => { await app.close(); });
beforeEach(() => {
  reset();
  app.ctx.db.forTenant('tn-one').run('DELETE FROM intake_holder_lockouts');
  snapshots.set('PA-IL-6671841', { policyNumber: 'PA-IL-6671841', ratingState: 'IL', namedInsureds: [{ name: 'Avery Brindle' }],
    vehicles: [{ unitId: 'veh-1', vin: '1GZUD0LL9MP394242', year: 2021, make: 'Aldera', model: 'Sedan LX', garagingPostalCode: '60002' }] });
  snapshots.set('CA-MI-1421980', { policyNumber: 'CA-MI-1421980', ratingState: 'MI', namedInsureds: [{ name: 'Brightfield Freight Co (fictional)' }],
    vehicles: [{ unitId: 'veh-1', year: 2022, make: 'Brightwell', model: 'Pickup 1500', garagingPostalCode: '48002' }] });
});

const start = (policyNumber, token = tok(['claimant'])) => call(app, 'POST', base, { token, body: { lob: 'personal_auto', channel: 'claimant_web', ...(policyNumber ? { policyNumber } : {}) } });

test('CSR-16 / CLAIMANT-9: a known policy shows only its risk state notice; no policy shows every state', async () => {
  const known = await start('PA-IL-6671841');
  assert.equal(known.status, 201);
  assert.deepEqual(known.body.disclosures, ['Notice (IL)']);
  const next = await call(app, 'GET', `${base}/${known.body.sessionId}/next-question`, { token: tok(['claimant']) });
  assert.equal(next.status, 200);
  assert.deepEqual(next.body.disclosures, ['Notice (IL)']);
  const unknown = await start();
  assert.deepEqual(unknown.body.disclosures.sort(), ['Notice (IL)', 'Notice (WI)']);
  const missing = await start('PA-ZZ-0000000');
  assert.equal(missing.body.disclosures.length, 2, 'an unknown policy number falls back to every notice');
});

test('CLAIMANT-8: a commercial insured is verified by its full business name only', async () => {
  const s = await start('CA-MI-1421980');
  const get = (lastName) => call(app, 'GET', `${base}/${s.body.sessionId}/policy-vehicles?lastName=${encodeURIComponent(lastName)}&zip=48002`, { token: tok(['claimant']) });
  for (const word of ['Co', '(fictional)', 'Freight']) assert.equal((await get(word)).status, 404, word);
  assert.equal((await get('Brightfield Freight Co')).status, 200);
  assert.equal((await get('brightfield freight co (fictional)')).status, 200);
});

test('CLAIMANT-8: a person insured still matches on the last name or the full name', async () => {
  const s = await start('PA-IL-6671841');
  for (const name of ['Brindle', 'Avery Brindle']) {
    const r = await call(app, 'GET', `${base}/${s.body.sessionId}/policy-vehicles?lastName=${encodeURIComponent(name)}&zip=60002`, { token: tok(['claimant']) });
    assert.equal(r.status, 200, name);
  }
});

test('CSR-14: a question made required by requiredIf is sent with required: true', async () => {
  const token = tok(['csr'], 'csr1');
  const s = await call(app, 'POST', base, { token, body: { lob: 'personal_auto', channel: 'csr_phone' } });
  const id = s.body.sessionId;
  const step = await call(app, 'POST', `${base}/${id}/answers`, { token, body: { answers: [
    { questionId: 'loss_date', value: '2026-10-01' }, { questionId: 'loss_description', value: 'Rear ended at a light.' },
    { questionId: 'injuries', value: false }, { questionId: 'vehicle_drivable', value: true }, { questionId: 'other_party_involved', value: true },
  ] } });
  assert.equal(step.status, 200);
  assert.equal(step.body.question.id, 'other_party_info');
  assert.equal(step.body.question.required, true);
  assert.ok(step.body.optional.every((q) => q.required === false));
  // Pure helper: explicit requiredness wins over the static flag.
  assert.equal(publicQuestion({ id: 'x', requiredIf: {} }, { required: true }).required, true);
  assert.equal(publicQuestion({ id: 'x', required: true }).required, true);
});

test('CLAIMANT-13: Spanish validation messages carry their accents', () => {
  assert.equal(validateAnswer({ type: 'disclosure' }, undefined, { locale: 'es' }), 'Se requiere confirmación.');
  assert.equal(validateAnswer({ type: 'boolean' }, 'x', { locale: 'es' }), 'Responda sí o no.');
  assert.equal(validateAnswer({ type: 'date' }, '2026-13-45', { locale: 'es' }), 'Ingrese una fecha válida (AAAA-MM-DD).');
  assert.equal(validateAnswer({ type: 'phone' }, 'x', { locale: 'es' }), 'Ingrese un teléfono válido.');
});

test('DATA-1: submit adds the policy named insured as the insured party (person and business)', async () => {
  const person = await enrichClaimCreate({ lob: 'personal_auto', policyNumber: 'PA-IL-6671841', lossEvent: { lossDate: '2026-10-01' } },
    { getSnapshot: async () => snapshots.get('PA-IL-6671841') });
  assert.deepEqual(person.parties[0], { kind: 'person', firstName: 'Avery', lastName: 'Brindle', roles: ['insured'], isPolicyParty: true });
  const biz = await enrichClaimCreate({ lob: 'commercial_auto', policyNumber: 'CA-MI-1421980', lossEvent: {} },
    { getSnapshot: async () => snapshots.get('CA-MI-1421980') });
  assert.equal(biz.parties[0].kind, 'organization');
  assert.equal(biz.parties[0].organizationName, 'Brightfield Freight Co (fictional)');
  const given = await enrichClaimCreate({ lob: 'personal_auto', policyNumber: 'PA-IL-6671841', parties: [{ kind: 'person', roles: ['insured'], lastName: 'Given' }], lossEvent: {} },
    { getSnapshot: async () => snapshots.get('PA-IL-6671841') });
  assert.equal(given.parties.length, 1, 'an insured party given by the caller is kept as is');
  assert.equal(store.calls.length, 0);
});
