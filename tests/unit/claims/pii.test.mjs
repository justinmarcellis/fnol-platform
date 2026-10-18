import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootClaimsApp, claimInput, user, call } from './helpers.mjs';

const SECRETS = ['Zelda', 'Quartz', 'zelda.quartz@example.test', '555 0142', '1985-04-12', '14 Birch Street', 'Q123-4567-8901', 'sore neck', 'ZQ-4471', 'Birch Street light'];

/** Every text column of every table, as one string per table, to prove nothing leaks. */
function dump(app) {
  const raw = app.ctx.db.raw;
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  return Object.fromEntries(tables.map((t) => [t, JSON.stringify(raw.prepare(`SELECT * FROM ${t}`).all())]));
}

test('x-pii fields are encrypted at rest and absent from events and audit', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const c = await svc.createClaim(claimInput(), { actor: user('csr') });
  await svc.addNote(c.id, { body: 'Zelda Quartz asked for a callback on 555 0142', category: 'contact' }, { actor: user('csr') });
  await app.ctx.bus.drain();

  for (const [table, text] of Object.entries(dump(app))) {
    for (const s of SECRETS) assert.ok(!text.includes(s), `plaintext "${s}" found in table ${table}`);
  }
  assert.match(app.ctx.db.raw.prepare('SELECT doc FROM claim_parties').get().doc, /enc:v1:/);
  assert.match(app.ctx.db.raw.prepare('SELECT doc FROM claim_notes').get().doc, /enc:v1:/);
  assert.match(app.ctx.db.raw.prepare('SELECT doc FROM claims').get().doc, /enc:v1:/);
  // non-PII stays queryable/readable
  assert.match(app.ctx.db.raw.prepare('SELECT doc FROM claim_vehicles').get().doc, /1HGBH41JXMN109186/);
});

test('service decrypts for internal callers and getClaimBundle; redact masks', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const c = await svc.createClaim(claimInput(), { actor: user('csr') });
  assert.equal(c.parties[0].firstName, 'Zelda');
  assert.deepEqual(c.parties[0].address, claimInput().parties[0].address);
  assert.deepEqual(c.parties[0].driversLicense, { number: 'Q123-4567-8901', state: 'WI' });
  const b = await svc.getClaimBundle(c.id);
  assert.equal(b.parties[0].email, 'zelda.quartz@example.test');
  assert.equal(b.vehicles[0].licensePlate, 'ZQ-4471');
  assert.match(b.claim.lossEvent.description, /Zelda Quartz/);
  assert.equal(b.claim.lossEvent.location.address.line1, '14 Birch Street');

  const red = await svc.getClaim(c.id, { include: ['parties', 'vehicles'], redact: true });
  assert.equal(red.parties[0].firstName, '[redacted]');
  assert.equal(red.parties[0].roles[0], 'insured');
  assert.equal(red.lossEvent.description, '[redacted]');
  assert.equal(red.vehicles[0].licensePlate, '[redacted]');
  assert.equal(red.vehicles[0].vin, '1HGBH41JXMN109186');
});

test('ciphertext is tenant-bound: another tenant cannot read the claim or decrypt it', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const c = await app.claims('alpha').createClaim(claimInput(), { actor: user('csr') });
  await assert.rejects(app.claims('beta').getClaim(c.id), { code: 'not_found' });
  const enc = JSON.parse(app.ctx.db.raw.prepare('SELECT doc FROM claim_parties').get().doc).firstName;
  assert.throws(() => app.ctx.crypto.decryptPii('beta', enc));
});

test('notes: body encrypted, returned decrypted to PII roles and redacted to others over HTTP', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const c = await app.claims().createClaim(claimInput(), { actor: user('csr') });
  const csr = app.token(['csr']);
  const posted = await call(app, 'POST', `/api/v1/claims/${c.id}/notes`, { token: csr, body: { body: 'Call Zelda back', category: 'contact' } });
  assert.equal(posted.status, 201);
  assert.equal(posted.json.body, 'Call Zelda back');
  assert.equal(posted.json.visibility, 'internal');
  const asCsr = await call(app, 'GET', `/api/v1/claims/${c.id}/notes`, { token: csr });
  assert.equal(asCsr.json.items[0].body, 'Call Zelda back');
  const asAuditor = await call(app, 'GET', `/api/v1/claims/${c.id}/notes`, { token: app.token(['integration']) });
  assert.equal(asAuditor.status, 403);
  const adminRedacted = await call(app, 'GET', `/api/v1/claims/${c.id}`, { token: app.token(['claimant']) });
  assert.equal(adminRedacted.json.lossEvent.description, '[redacted]');
  const full = await call(app, 'GET', `/api/v1/claims/${c.id}?include=parties`, { token: csr });
  assert.equal(full.json.parties[0].lastName, 'Quartz');
  assert.ok(!(await call(app, 'GET', `/api/v1/claims/${c.id}`, { token: app.token(['claimant']) })).text.includes('Quartz'));
});

test('location.description and location.geo are x-pii: round-trip, encrypted at rest, redactable', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const geo = { lat: 43.07311, lng: -89.40123 };
  const input = claimInput();
  input.lossEvent.location = { ...input.lossEvent.location, description: 'Behind the Quince Hardware lot', geo };
  const c = await svc.createClaim(input, { actor: user('csr') });
  await app.ctx.bus.drain();
  assert.deepEqual(c.lossEvent.location.geo, geo);
  assert.equal(c.lossEvent.location.description, 'Behind the Quince Hardware lot');
  assert.deepEqual((await svc.getClaim(c.id)).lossEvent.location.geo, geo);
  const doc = JSON.parse(app.ctx.db.raw.prepare('SELECT doc FROM claims').get().doc);
  assert.match(doc.lossEvent.location.geo, /^enc:v1:/);
  assert.match(doc.lossEvent.location.description, /^enc:v1:/);
  for (const [table, text] of Object.entries(dump(app))) {
    assert.ok(!text.includes('43.07311'), `geo leaked in ${table}`);
    assert.ok(!text.includes('Quince Hardware'), `location description leaked in ${table}`);
  }
  const red = await svc.getClaim(c.id, { redact: true });
  assert.equal(red.lossEvent.location.geo, '[redacted]');
  assert.equal(red.lossEvent.location.description, '[redacted]');
});
