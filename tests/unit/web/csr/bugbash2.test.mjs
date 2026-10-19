// S6-BUG-02 round 2 regression tests (S6-RA-02, S6-RA-04, S6-RA-14). Pure modules; browser flows in tests/ui/csr.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAssistedIntake, lossTypeOptions, initialLossType } from '../../../../src/web/csr/assisted.js';
import { createRecent, currentStatus } from '../../../../src/web/csr/recent.js';
import { deskAccess, AGENT_ACCESS } from '../../../../src/web/csr/roles.js';
import { makeT } from '../../../../src/web/csr/strings.js';
import { fakeApi, step, q } from './helpers.mjs';

const t = makeT('en');
const dir = new URL('../../../../src/web/csr/', import.meta.url);
const LOBS = [
  { id: 'personal_auto', lossTypes: [{ id: 'collision', label: { en: 'Collision', es: 'Colisión' }, causes: ['collision'] }, { id: 'glass', label: 'Glass damage', causes: ['glass'] }] },
  { id: 'homeowners', lossTypes: [{ id: 'water', label: { en: 'Water damage' }, causes: ['water_plumbing'] }] },
  { id: 'renters' },
];

// ---- S6-RA-02: the desk sends a loss type, so the claim's cause is not 'other'
test('S6-RA-02: loss type options come from the tenant line; the first is the default', () => {
  assert.deepEqual(lossTypeOptions(LOBS, 'personal_auto'), [{ value: 'collision', label: 'Collision' }, { value: 'glass', label: 'Glass damage' }]);
  assert.equal(lossTypeOptions(LOBS, 'personal_auto', 'es')[0].label, 'Colisión');
  assert.deepEqual(lossTypeOptions(LOBS, 'renters'), []);
  assert.deepEqual(lossTypeOptions(null, 'x'), []);
  assert.equal(initialLossType(lossTypeOptions(LOBS, 'personal_auto')), 'collision');
  assert.equal(initialLossType(lossTypeOptions(LOBS, 'personal_auto'), 'glass'), 'glass');
  assert.equal(initialLossType(lossTypeOptions(LOBS, 'personal_auto'), 'fire'), 'collision', 'an unknown loss type is not sent');
  assert.equal(initialLossType([]), undefined);
});

test('S6-RA-02: the session starts with the loss type and can switch it until the first answer', async () => {
  let n = 0;
  const api = fakeApi({
    'POST /intake/sessions': () => step({ sessionId: `s${++n}`, question: q('loss_date', { type: 'date' }), optional: [{ id: 'insured_vehicle', type: 'vehicle', text: 'Vehicle', order: 60 }] }),
    'POST /intake/sessions/:id/answers': () => step({ sessionId: `s${n}`, question: q('loss_description') }),
  });
  const f = createAssistedIntake({ api, t });
  await f.start({ lob: 'personal_auto', policyNumber: 'PA-MI-1', lossType: 'collision', channel: 'csr_phone' });
  assert.equal(api.calls[0].body.lossType, 'collision');
  assert.equal(f.state.lossType, 'collision');
  f.setExternal(['insured_vehicle']);
  assert.equal(f.canChangeLossType, true);
  await f.changeLossType('glass');
  assert.equal(api.calls[1].path, '/intake/sessions');
  assert.deepEqual({ lob: api.calls[1].body.lob, policyNumber: api.calls[1].body.policyNumber, lossType: api.calls[1].body.lossType, channel: api.calls[1].body.channel },
    { lob: 'personal_auto', policyNumber: 'PA-MI-1', lossType: 'glass', channel: 'csr_phone' });
  assert.equal(f.state.sessionId, 's2');
  assert.equal(f.state.question?.id, 'loss_date', 'the picker still owns the vehicle question after the switch');
  await f.answer('loss_date', '2026-10-18');
  assert.equal(f.canChangeLossType, false);
  const before = api.calls.length;
  assert.equal(await f.changeLossType('collision'), null, 'locked after the first answer');
  assert.equal(api.calls.length, before);
  assert.equal(f.state.lossType, 'glass');
});

test('S6-RA-02: the desk wires the loss type into intake.start (no session without one when the tenant offers them)', () => {
  const app = readFileSync(new URL('app.js', dir), 'utf8');
  assert.match(app, /lossOptions = lossTypeOptions\(lobs, lob, locale\)/);
  assert.match(app, /intake\.start\(\{ lob, policyNumber: row\.policyNumber, locale, lossType,/);
  assert.match(readFileSync(new URL('index.html', dir), 'utf8'), /id="loss-type-pick"/);
  for (const loc of ['en', 'es']) for (const k of ['csr.lossType.label', 'csr.lossType.hint', 'csr.lossType.locked']) assert.notEqual(makeT(loc)(k), k);
});

// ---- S6-RA-04: agents get the policy details, the vehicle picker and recent claims
test('S6-RA-04: the agent desk uses the snapshot, the vehicle picker, recent claims and the claim view', () => {
  assert.deepEqual({ ...AGENT_ACCESS }, { policySnapshot: true, policyVehicles: true, recentClaims: true, claimView: true });
  assert.deepEqual({ ...deskAccess('agent') }, { ...deskAccess('csr') });
});

// ---- S6-RA-14: the confirmation status follows the claim
test('S6-RA-14: the confirmation shows the settled status from the recent list, else the submit status', async () => {
  const claim = { id: 'c1', status: 'reported' };
  assert.equal(currentStatus(claim, []), 'reported');
  assert.equal(currentStatus(claim, [{ id: 'c0', status: 'closed' }, { id: 'c1', status: 'assigned' }]), 'assigned');
  assert.equal(currentStatus(null, [{ id: 'c1', status: 'assigned' }]), '');
  const api = fakeApi({ 'GET /claims': { items: [{ id: 'c1', status: 'assigned' }] } });
  const r = createRecent({ api, t });
  await r.refreshUntilSettled('c1', { delays: [], sleep: async () => {} });
  assert.equal(currentStatus(claim, r.state.rows), 'assigned');
  const app = readFileSync(new URL('app.js', dir), 'utf8');
  assert.match(app, /if \(doneClaim && s\.kind !== 'open'\) showDoneStatus\(s\.rows\)/);
  assert.doesNotMatch(app, /formatEnum\(claim\.status\)/, 'the stale submit status is not printed directly');
});

test('S6-RA-04: the agent sees no column or field the claimant-safe projection never carries', async () => {
  const { visibleColumns, recentColumns, claimSummary } = await import('../../../../src/web/csr/recent.js');
  const cols = recentColumns(t);
  assert.deepEqual(visibleColumns(cols, [{ id: 'c1', status: 'assigned' }]).map((c) => c.key), ['claimNumber', 'status', 'lob', 'reportedAt']);
  assert.equal(visibleColumns(cols, [{ id: 'c1' }, { id: 'c2', policyNumber: 'PA-WI-1' }]).length, 5);
  assert.equal(visibleColumns(cols, []).length, 5);
  const projected = { id: 'c1', claimNumber: 'AUR-2026-000016', status: 'assigned', lob: 'personal_auto', lossType: 'collision', reportedAt: '2026-10-19T21:14:00Z', lossEvent: { lossDate: '2026-10-18', cause: 'collision' } };
  const agent = claimSummary(projected, t, { projected: true });
  assert.deepEqual(agent.map((f) => f.key), ['status', 'lob', 'lossType', 'lossDate', 'reportedAt']);
  assert.ok(!agent.some((f) => f.value === t('csr.claim.none')));
  const csr = claimSummary(projected, t);
  assert.equal(csr.find((f) => f.key === 'policyNumber').value, t('csr.claim.none'), 'the CSR view still says what is missing');
  assert.equal(csr.find((f) => f.key === 'lossType').value, 'collision');
});
