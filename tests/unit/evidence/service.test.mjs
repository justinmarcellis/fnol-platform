import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootEvidenceApp, makeFakeAi, textBytes, simplePdf } from './helpers.mjs';
import { blobPath } from '../../../src/modules/evidence/blobs.mjs';

const CLAIM = 'clm_00000000000000000001';
const REPORT = 'Police Report\nReport No: PR-2026-0042\nCited: Jordan Example\nOfficer: Sample';

test('bytes are encrypted at rest and round-trip; read is audited', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const ev = app.ev();
  const plain = textBytes('SECRET-PLAINTEXT-MARKER policy notes');
  const doc = await ev.addDocument(CLAIM, { kind: 'other', filename: 'n.txt', contentType: 'text/plain', bytes: plain }, { actor: { type: 'user', id: 'u1' } });
  assert.equal(doc.sizeBytes, plain.length);
  assert.match(doc.sha256, /^[a-f0-9]{64}$/);
  assert.equal(doc.extraction.status, 'pending');
  const file = blobPath(app.ctx, doc.storageKey);
  assert.ok(file.includes(`${'blobs'}`) && file.endsWith(`alpha/${CLAIM}/${doc.id}`));
  assert.ok(file.startsWith(app.dir), 'blobs live next to dbPath');
  const onDisk = fs.readFileSync(file);
  assert.ok(!onDisk.includes('SECRET-PLAINTEXT-MARKER'));
  const back = await ev.readContent(CLAIM, doc.id, { actor: { type: 'user', id: 'u1' } });
  assert.deepEqual(back.bytes, plain);
  assert.equal(back.contentType, 'text/plain');
  const audit = app.ctx.audit.list('alpha', { action: 'evidence.content.read' });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].entity_id ?? audit[0].entityId, doc.id);
});

test('tenant isolation', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const doc = await app.ev('alpha').addDocument(CLAIM, { kind: 'other', filename: 'a.txt', contentType: 'text/plain', bytes: textBytes('x') });
  await assert.rejects(app.ev('beta').getDocument(CLAIM, doc.id), { status: 404 });
  assert.deepEqual(await app.ev('beta').listDocuments(CLAIM), []);
});

test('validation: size, type, kind, empty', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const ev = app.ev();
  await assert.rejects(ev.addDocument(CLAIM, { filename: 'a.exe', contentType: 'application/x-msdownload', bytes: textBytes('x') }), { status: 415 });
  await assert.rejects(ev.addDocument(CLAIM, { filename: 'a.txt', contentType: 'text/plain', bytes: Buffer.alloc(10 * 1024 * 1024 + 1, 97) }), { status: 413 });
  await assert.rejects(ev.addDocument(CLAIM, { kind: 'bogus', filename: 'a.txt', contentType: 'text/plain', bytes: textBytes('x') }), { status: 400 });
  await assert.rejects(ev.addDocument(CLAIM, { filename: 'a.txt', contentType: 'text/plain', bytes: Buffer.alloc(0) }), { status: 400 });
});

test('event triggers extraction; fields carry confidence and provenance; event has no PII', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const ev = app.ev();
  const seen = [];
  app.ctx.bus.on('claim.evidence.extracted', (e) => { seen.push(e); }, { name: 'test:extracted' });
  const doc = await ev.addDocument(CLAIM, { kind: 'police_report', filename: 'report.txt', contentType: 'text/plain', bytes: textBytes(REPORT) });
  await app.ctx.bus.drain();
  const got = await ev.getDocument(CLAIM, doc.id);
  assert.equal(got.extraction.status, 'partial'); // fake flags a 0.55 field for review
  const num = got.extraction.fields.find((f) => f.name === 'policeReportNumber');
  assert.equal(num.value, 'PR-2026-0042');
  assert.equal(num.confidence, 0.95);
  assert.equal(num.provenance.source, 'ai_extraction');
  assert.equal(num.provenance.documentId, doc.id);
  assert.match(num.provenance.span, /PR-2026-0042/);
  assert.equal(num.accepted, null);
  assert.equal(got.extraction.ai.provider, 'local');
  assert.equal(got.extraction.needsReview, true);
  assert.equal(seen.length, 1);
  const data = JSON.stringify(seen[0].data);
  assert.ok(!data.includes('Jordan') && !data.includes('PR-2026-0042'));
  assert.equal(seen[0].data.documentId, doc.id);
  assert.deepEqual(seen[0].data.lowConfidenceFields, ['citedParty']);
  // stored extraction is not plaintext in the db
  const row = app.ctx.db.raw.prepare('SELECT doc FROM extractions WHERE document_id = ?').get(doc.id);
  assert.ok(!row.doc.includes('Jordan'));
});

test('extract is idempotent unless force', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const ev = app.ev();
  const doc = await ev.addDocument(CLAIM, { kind: 'police_report', filename: 'r.txt', contentType: 'text/plain', bytes: textBytes(REPORT) });
  await app.ctx.bus.drain();
  assert.equal(app.ai.calls.length, 1);
  assert.equal(app.ai.calls[0].opts.claimId, CLAIM);
  assert.equal(app.ai.calls[0].opts.tenantId, 'alpha');
  await ev.extract(doc.id);
  assert.equal(app.ai.calls.length, 1);
  await ev.extract(doc.id, { force: true });
  assert.equal(app.ai.calls.length, 2);
  assert.equal(app.ctx.db.raw.prepare('SELECT COUNT(*) n FROM extractions WHERE document_id = ?').get(doc.id).n, 1);
});

test('kind auto-detect from filename and content', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const ev = app.ev();
  const add = (filename, contentType, bytes) => ev.addDocument(CLAIM, { filename, contentType, bytes });
  assert.equal((await add('IMG_1.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff]))).kind, 'photo');
  assert.equal((await add('police-report.txt', 'text/plain', textBytes('x'))).kind, 'police_report');
  assert.equal((await add('notes.txt', 'text/plain', textBytes('Repair estimate for bumper'))).kind, 'estimate');
  assert.equal((await add('inv.txt', 'text/plain', textBytes('Invoice 12, amount due'))).kind, 'invoice');
  assert.equal((await add('misc.txt', 'text/plain', textBytes('hello'))).kind, 'other');
  assert.equal((await add('scan.pdf', 'application/pdf', simplePdf(['Collision Repair Estimate', 'Total: $1,200.00']))).kind, 'estimate');
});

test('simple PDF text is extracted; unreadable PDF needs review without calling AI', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const ev = app.ev();
  const good = await ev.addDocument(CLAIM, { kind: 'estimate', filename: 'e.pdf', contentType: 'application/pdf', bytes: simplePdf(['Repair Estimate', 'Total: $1,234.50']) });
  const bad = await ev.addDocument(CLAIM, { kind: 'estimate', filename: 'scan.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n\x00\x01binary garbage\n%%EOF') });
  await app.ctx.bus.drain();
  const g = await ev.getDocument(CLAIM, good.id);
  assert.equal(g.extraction.fields.find((f) => f.name === 'estimateTotal').value, 1234.5);
  assert.match(app.ai.calls[0].input.text, /Repair Estimate/);
  const b = await ev.getDocument(CLAIM, bad.id);
  assert.equal(b.extraction.status, 'partial');
  assert.equal(b.extraction.needsReview, true);
  assert.deepEqual(b.extraction.fields, []);
  assert.equal(app.ai.calls.length, 1);
});

test('photo: sidecar metadata used; without it confidence is low', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const ev = app.ev();
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const withMd = await ev.addDocument(CLAIM, { filename: 'a.jpg', contentType: 'image/jpeg', bytes: jpg, metadata: { damageAreas: ['rear_bumper'], make: 'Examplar', model: 'Coupe', color: 'red', takenAt: '2026-09-15T10:00:00Z', device: 'phone' } });
  const noMd = await ev.addDocument(CLAIM, { filename: 'b.jpg', contentType: 'image/jpeg', bytes: jpg });
  await app.ctx.bus.drain();
  const a = await ev.getDocument(CLAIM, withMd.id);
  assert.deepEqual(app.ai.calls.find((c) => c.input.filename === 'a.jpg').input.metadata.damageAreas, ['rear_bumper']);
  assert.equal(a.extraction.status, 'completed');
  assert.deepEqual(a.extraction.fields.find((f) => f.name === 'damageAreas').value, ['rear_bumper']);
  assert.equal(a.extraction.labels[0].label, 'rear_bumper');
  assert.equal(a.captureMetadata.device, 'phone');
  const b = await ev.getDocument(CLAIM, noMd.id);
  assert.ok(b.extraction.fields.every((f) => f.confidence <= 0.4));
  assert.equal(b.extraction.needsReview, true);
  assert.equal(app.ai.calls.find((c) => c.input.filename === 'b.jpg').input.metadata, undefined);
});

test('AI failure marks extraction failed and does not throw', async (t) => {
  const app = await bootEvidenceApp({ ai: makeFakeAi({ extract_document: () => { throw new Error('boom'); } }) });
  t.after(() => app.close());
  const doc = await app.ev().addDocument(CLAIM, { kind: 'other', filename: 'a.txt', contentType: 'text/plain', bytes: textBytes('hello') });
  await app.ctx.bus.drain();
  assert.equal((await app.ev().getDocument(CLAIM, doc.id)).extraction.status, 'failed');
});

test('reviewExtraction and getAcceptedFacts', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const ev = app.ev();
  const doc = await ev.addDocument(CLAIM, { kind: 'police_report', filename: 'r.txt', contentType: 'text/plain', bytes: textBytes(`${REPORT}\nTotal: 900`) });
  await app.ctx.bus.drain();
  let facts = await ev.getAcceptedFacts(CLAIM);
  assert.deepEqual(Object.keys(facts).sort(), ['estimateTotal', 'policeReportNumber']); // citedParty at 0.55 excluded
  assert.equal(facts.policeReportNumber.provenance.source, 'ai_extraction');
  await ev.reviewExtraction(doc.id, [
    { name: 'citedParty', accepted: true, value: 'Corrected Person' },
    { name: 'policeReportNumber', accepted: false },
  ], { actor: { type: 'user', id: 'adj1' } });
  facts = await ev.getAcceptedFacts(CLAIM);
  assert.equal(facts.citedParty.value, 'Corrected Person');
  assert.equal(facts.policeReportNumber, undefined);
  const ext = (await ev.getDocument(CLAIM, doc.id)).extraction;
  assert.equal(ext.fields.find((f) => f.name === 'citedParty').provenance.confirmedBy, 'adj1');
  await assert.rejects(ev.reviewExtraction(doc.id, [{ name: 'nope', accepted: true }]), { status: 404 });
  assert.ok(app.ctx.audit.list('alpha', { action: 'evidence.extraction.reviewed' }).length === 1);
});
