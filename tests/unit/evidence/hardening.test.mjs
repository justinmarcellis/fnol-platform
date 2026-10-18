import test from 'node:test';
import assert from 'node:assert/strict';
import { bootEvidenceApp, textBytes, simplePdf } from './helpers.mjs';
import { sniffContentType } from '../../../src/modules/evidence/index.mjs';

const CLAIM = 'clm_00000000000000000001';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);

test('sniffContentType recognises each allowed type and rejects binary junk', () => {
  assert.equal(sniffContentType(PNG), 'image/png');
  assert.equal(sniffContentType(JPG), 'image/jpeg');
  assert.equal(sniffContentType(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(sniffContentType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp');
  assert.equal(sniffContentType(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')])), 'image/heic');
  assert.equal(sniffContentType(simplePdf(['hello'])), 'application/pdf');
  assert.equal(sniffContentType(textBytes('plain words')), 'text/plain');
  assert.equal(sniffContentType(Buffer.from([1, 2, 3, 0, 4])), null);
  assert.equal(sniffContentType(Buffer.alloc(0)), null);
});

test('content-type mismatch is rejected with 415 (service and route)', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const ev = app.ev();
  await assert.rejects(ev.addDocument(CLAIM, { filename: 'a.jpg', contentType: 'image/jpeg', bytes: PNG }), { status: 415 });
  await assert.rejects(ev.addDocument(CLAIM, { filename: 'a.pdf', contentType: 'application/pdf', bytes: textBytes('not a pdf') }), { status: 415 });
  await assert.rejects(ev.addDocument(CLAIM, { filename: 'a.txt', contentType: 'text/plain', bytes: PNG }), { status: 415 });
  const ok = await ev.addDocument(CLAIM, { filename: 'a.png', contentType: 'image/png', bytes: PNG });
  assert.equal(ok.contentType, 'image/png');
  const r = await fetch(`${app.url}/api/v1/claims/${CLAIM}/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${app.token(['csr'])}` },
    body: JSON.stringify({ filename: 'x.png', contentType: 'image/png', contentBase64: textBytes('hello').toString('base64') }),
  });
  assert.equal(r.status, 415);
});

test('upload size comes from tenant config, 10 MB by default', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  app.ctx.tenants.put('beta', { id: 'beta', displayName: 'beta Example', evidence: { maxUploadBytes: 100 } }, 'test');
  const big = textBytes('a'.repeat(101));
  await assert.rejects(app.ev('beta').addDocument(CLAIM, { filename: 'a.txt', contentType: 'text/plain', bytes: big }), { status: 413 });
  await app.ev('beta').addDocument(CLAIM, { filename: 'a.txt', contentType: 'text/plain', bytes: textBytes('a'.repeat(100)) });
  // alpha has no setting: the same 101 bytes pass, 10 MB + 1 fails, exactly 10 MB passes
  await app.ev('alpha').addDocument(CLAIM, { filename: 'a.txt', contentType: 'text/plain', bytes: big });
  await assert.rejects(app.ev('alpha').addDocument(CLAIM, { filename: 'a.txt', contentType: 'text/plain', bytes: Buffer.alloc(10 * 1024 * 1024 + 1, 97) }), { status: 413 });
  await app.ev('alpha').addDocument(CLAIM, { filename: 'a.txt', contentType: 'text/plain', bytes: Buffer.alloc(10 * 1024 * 1024, 97) });
});

test('subscriber logs and returns for a missing claim or document, never throws', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const ev = app.ev();
  const doc = await ev.addDocument(CLAIM, { kind: 'other', filename: 'a.txt', contentType: 'text/plain', bytes: textBytes('note') });
  await app.ctx.bus.drain();
  // event for a document that does not exist, and one with no ids
  app.ctx.bus.publish('alpha', 'claim.evidence.added', 'clm_gone', { claimId: 'clm_gone', documentId: 'doc_missing', kind: 'other', contentType: 'text/plain', sizeBytes: 1, sha256: 'a'.repeat(64) });
  app.ctx.bus.publish('alpha', 'claim.evidence.added', 'clm_gone', {});
  await app.ctx.bus.drain();
  const rows = app.ctx.bus.outbox('alpha').filter((r) => r.subject === 'clm_gone');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'delivered'), JSON.stringify(rows.map((r) => [r.status, r.last_error])));
  assert.equal((await ev.getDocument(CLAIM, doc.id)).id, doc.id);
});
