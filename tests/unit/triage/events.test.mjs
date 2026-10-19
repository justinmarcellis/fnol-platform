import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTriageApp } from './helpers.mjs';
import { reset, putClaim, setFacts, setCoverage, makeAi } from './fakes.mjs';

let app; let ai;
let n = 0;
const nextId = () => `clm_${String(++n).padStart(20, '0')}`;
before(async () => { ai = makeAi(); app = await bootTriageApp(ai); });
after(async () => { await app.close(); });
beforeEach(() => { reset(); ai.calls.length = 0; });

const bus = () => app.ctx.forTenant('alpha').bus;
const covered = (id) => bus().publish('claim.coverage.verified', id, { claimId: id, verificationId: 'cvr_1', outcome: 'covered', matchedCoverages: [], failedChecks: [] });
const extracted = (id) => bus().publish('claim.evidence.extracted', id, { claimId: id, documentId: 'doc_1', extractionId: 'ext_1', status: 'completed' });
const results = (id) => app.triage().listTriage(id);

test('claim.coverage.verified runs the first triage and claim.triaged does not retrigger triage', async () => {
  const id = nextId();
  putClaim('alpha', { id });
  covered(id);
  await app.ctx.bus.drain();
  assert.equal((await results(id)).length, 1);
  assert.equal(app.events('claim.triaged').filter((e) => e.subject === id).length, 1);
  await app.ctx.bus.drain();
  assert.equal((await results(id)).length, 1);
});

test('replaying the same coverage event does not triage twice', async () => {
  const id = nextId();
  putClaim('alpha', { id });
  const evt = covered(id);
  await app.ctx.bus.drain();
  app.ctx.db.raw.prepare("UPDATE outbox SET status = 'pending' WHERE id = ?").run(evt.id);
  app.ctx.bus.recover(['alpha']);
  await app.ctx.bus.drain();
  assert.equal((await results(id)).length, 1);
  const again = await app.triage().onEvent('coverage', evt);
  assert.equal(again.attempt, 1);
  assert.equal((await results(id)).length, 1);
});

test('claim.evidence.extracted re-triages only when inputs changed', async () => {
  const id = nextId();
  putClaim('alpha', { id });
  covered(id);
  await app.ctx.bus.drain();
  extracted(id); // nothing changed
  await app.ctx.bus.drain();
  assert.equal((await results(id)).length, 1);
  setFacts('alpha', id, { estimateTotal: 8000, damageAreas: ['rear bumper'] });
  extracted(id);
  await app.ctx.bus.drain();
  const all = await results(id);
  assert.equal(all.length, 2);
  assert.equal(all[1].attempt, 2);
  assert.ok(all[1].fraud.indicators.some((i) => i.code === 'ROUND_NUMBER_ESTIMATE'));
});

test('no re-triage once the claim is in_review (or later)', async () => {
  for (const status of ['in_review', 'pending_info', 'closed']) {
    const id = nextId();
    putClaim('alpha', { id });
    covered(id);
    await app.ctx.bus.drain();
    putClaim('alpha', { id, claim: { status } });
    setFacts('alpha', id, { estimateTotal: 9000 });
    extracted(id);
    covered(id);
    await app.ctx.bus.drain();
    assert.equal((await results(id)).length, 1, status);
  }
});

test('evidence before any triage does not triage; unknown claim or missing claimId is ignored', async () => {
  const id = nextId();
  putClaim('alpha', { id });
  extracted(id);
  bus().publish('claim.coverage.verified', 'clm_unknown', { claimId: 'clm_unknown', verificationId: 'v', outcome: 'covered', matchedCoverages: [], failedChecks: [] });
  await app.ctx.bus.drain();
  assert.equal((await results(id)).length, 0);
  assert.equal(app.ctx.bus.outbox('alpha', 'failed').length, 0);
});

test('events run in the event tenant only', async () => {
  const id = nextId();
  putClaim('alpha', { id });
  covered(id);
  await app.ctx.bus.drain();
  assert.equal((await app.triage('beta').listTriage(id)).length, 0);
  assert.equal((await results(id)).length, 1);
});
