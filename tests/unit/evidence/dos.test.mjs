import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { bootEvidenceApp, call, makeFakeAi, textBytes, simplePdf } from './helpers.mjs';
import { extractPdfText, extractEstimateGrandTotal } from '../../../src/modules/evidence/parse.mjs';

const CLAIM = 'clm_00000000000000000001';
const URL = `/api/v1/claims/${CLAIM}/documents`;
const LIMIT_MS = 200;

function timed(fn) {
  const t0 = performance.now();
  const out = fn();
  return { out, ms: performance.now() - t0 };
}

test('SEC2-005: adversarial PDFs are scanned in linear time and never throw', () => {
  const cases = {
    'BT without ET': Buffer.from(`%PDF-1.4\n${'BT '.repeat(100000)}`, 'latin1'),
    'BT with unbalanced strings': Buffer.from(`%PDF-1.4\nBT ${'( '.repeat(100000)} ET`, 'latin1'),
    'unterminated TJ arrays': Buffer.from(`%PDF-1.4\nBT ${'[ '.repeat(100000)} ET`, 'latin1'),
    'repeated stream newline': Buffer.from(`%PDF-1.4\n${'stream\n'.repeat(100000)}`, 'latin1'),
    'repeated empty streams': Buffer.from(`%PDF-1.4\n${'stream\nendstream\n'.repeat(50000)}`, 'latin1'),
    'many tiny flate streams': Buffer.concat([Buffer.from('%PDF-1.4\n'), ...Array.from({ length: 2000 }, () => Buffer.concat([Buffer.from('stream\n'), zlib.deflateSync(Buffer.from('BT (x) Tj ET')), Buffer.from('\nendstream\n')]))]),
  };
  for (const [name, pdf] of Object.entries(cases)) {
    const { out, ms } = timed(() => extractPdfText(pdf));
    assert.equal(typeof out, 'string', name);
    assert.ok(ms < LIMIT_MS, `${name} took ${ms.toFixed(0)} ms`);
  }
});

test('SEC2-005: flate bomb is skipped by maxOutputLength, rest of the document still reads', () => {
  const bomb = zlib.deflateSync(Buffer.alloc(300 * 1024 * 1024));
  assert.ok(bomb.length < 1024 * 1024);
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\nBT (Visible Line) Tj ET\nstream\n'), bomb, Buffer.from('\nendstream\n'),
  ]);
  const { out, ms } = timed(() => extractPdfText(pdf));
  assert.ok(ms < LIMIT_MS, `bomb took ${ms.toFixed(0)} ms`);
  assert.equal(out, 'Visible Line');
});

test('valid PDFs still work: plain, TJ arrays with escapes, and Flate streams', () => {
  assert.equal(extractPdfText(simplePdf(['Hello (World)', 'Second'])), 'Hello (World)\nSecond');
  assert.equal(extractPdfText(Buffer.from('%PDF-1.4\nBT [(Tot) -20 (al: 5\\051)] TJ ET\n', 'latin1')), 'Total: 5)');
  const flate = Buffer.concat([
    Buffer.from('%PDF-1.4\nstream\r\n'), zlib.deflateSync(Buffer.from('BT (Inside Flate) Tj ET')), Buffer.from('\r\nendstream\n'),
  ]);
  assert.equal(extractPdfText(flate), 'Inside Flate');
  assert.equal(extractPdfText(Buffer.from('not a pdf')), '');
});

test('SEC2-006: 80,000 spaces plus "!" is rejected fast with 400; invalid and valid base64 behave', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const token = app.token(['csr']);
  const body = (contentBase64) => ({ kind: 'other', filename: 'a.txt', contentType: 'text/plain', contentBase64 });
  let t0 = performance.now();
  const evil = await call(app, 'POST', URL, { token, body: body(`${' '.repeat(80000)}!`) });
  assert.equal(evil.status, 400);
  assert.ok(performance.now() - t0 < LIMIT_MS * 2, 'request round trip');
  for (const bad of ['abc$', 'ab=c', 'a=b=', '====', '   ', 'ab===', 'abéd']) {
    assert.equal((await call(app, 'POST', URL, { token, body: body(bad) })).status, 400, JSON.stringify(bad));
  }
  const ok = await call(app, 'POST', URL, { token, body: body(`${Buffer.from('hello world').toString('base64').replace(/^(.{4})/, '$1\n')}`) });
  assert.equal(ok.status, 201);
  const huge = await call(app, 'POST', URL, { token, body: body('A'.repeat(17 * 1024 * 1024)) });
  assert.ok([400, 413].includes(huge.status));
});

test('estimateTotal is the grand total, not the parts subtotal', async (t) => {
  const text = 'Repair Estimate\nParts: $2,090.00\nLabor: $1,798.00\nTax: $311.04\nGrand total: $4,199.04\n';
  assert.equal(extractEstimateGrandTotal(text), 4199.04);
  assert.equal(extractEstimateGrandTotal('Estimate\nParts total: 2090\nLabor: 1798\nTax: 150'), 4038);
  assert.equal(extractEstimateGrandTotal('Amount due: $1,200.50'), 1200.5);
  assert.equal(extractEstimateGrandTotal('nothing here'), undefined);
  // the fake AI mimics the real bug: it picks the first "total" (parts subtotal)
  const ai = makeFakeAi();
  const app = await bootEvidenceApp({ ai });
  t.after(() => app.close());
  const doc = await app.ev().addDocument(CLAIM, { kind: 'estimate', filename: 'e.txt', contentType: 'text/plain', bytes: textBytes('Estimate\nParts total: 2090\nLabor: 1798\nTax: 150\nGrand total: 4038'), source: 'csr_upload' });
  await app.ctx.bus.drain();
  const ext = (await app.ev().getDocument(CLAIM, doc.id)).extraction;
  assert.equal(ext.fields.find((f) => f.name === 'estimateTotal').value, 4038);
  assert.equal((await app.ev().getAcceptedFacts(CLAIM)).estimateTotal.value, 4038);
});

test('SEC2-012: claimant-sourced facts are suggestions until accepted; staff sources count', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const ev = app.ev();
  const bytes = textBytes('Police Report\nReport No: PR-2026-0042');
  const doc = await ev.addDocument(CLAIM, { kind: 'police_report', filename: 'r.txt', contentType: 'text/plain', bytes, source: 'claimant_upload' });
  await app.ctx.bus.drain();
  assert.deepEqual(await ev.getAcceptedFacts(CLAIM), {});
  await ev.reviewExtraction(doc.id, [{ name: 'policeReportNumber', accepted: true }], { actor: { type: 'user', id: 'adj1' } });
  assert.equal((await ev.getAcceptedFacts(CLAIM)).policeReportNumber.value, 'PR-2026-0042');
  const staffDoc = await ev.addDocument(CLAIM, { kind: 'estimate', filename: 'e.txt', contentType: 'text/plain', bytes: textBytes('Estimate\nGrand total: 900'), source: 'csr_upload' });
  await app.ctx.bus.drain();
  assert.equal((await ev.getAcceptedFacts(CLAIM)).estimateTotal.value, 900);
  assert.ok(staffDoc.id);
});

test('SEC2-017: pii:true extraction fields are masked for auditor and integration, visible to csr', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const csr = app.token(['csr']);
  const doc = await call(app, 'POST', URL, { token: csr, body: { kind: 'police_report', filename: 'pr.txt', contentType: 'text/plain', contentBase64: Buffer.from('Police report no: PR-12345\nCited: Mallory Fictionton').toString('base64') } });
  assert.equal(doc.status, 201);
  await app.ctx.bus.drain();
  const raw = await app.ev().getDocument(CLAIM, doc.json.id);
  assert.ok(raw.extraction.fields.some((f) => f.pii), 'precondition: a pii field exists');
  const full = await call(app, 'GET', `${URL}/${doc.json.id}/extraction`, { token: csr });
  assert.ok(full.buf.toString().includes('Fictionton'));
  for (const role of ['auditor', 'integration']) {
    const tok = app.token([role], 'alpha', `x-${role}`);
    const ex = await call(app, 'GET', `${URL}/${doc.json.id}/extraction`, { token: tok });
    assert.equal(ex.status, 200);
    assert.ok(!ex.buf.toString().includes('Fictionton'), `${role} extraction`);
    assert.ok(ex.json.fields.some((f) => f.name === 'policeReportNumber' && f.value === 'PR-12345'), 'non-pii fields stay');
    const d = await call(app, 'GET', `${URL}/${doc.json.id}`, { token: tok });
    assert.ok(!d.buf.toString().includes('Fictionton'), `${role} document view`);
    const l = await call(app, 'GET', URL, { token: tok });
    assert.ok(!l.buf.toString().includes('Fictionton'), `${role} list`);
  }
});

test('S4-AI-02: ~12 MB unterminated TJ PDF and huge BT/ET sections return fast', async () => {
  const { MAX_MULTIPART_PARTS } = await import('../../../src/modules/evidence/parse.mjs');
  assert.equal(MAX_MULTIPART_PARTS, 20);
  const cases = {
    'unterminated TJ then ET': Buffer.from(`%PDF-1.4\nBT [${'(a) '.repeat(3_000_000)}\nET`, 'latin1'),
    'unterminated TJ no ET': Buffer.from(`%PDF-1.4\nBT [${'(a) '.repeat(3_000_000)}`, 'latin1'),
    'huge section of unmatched strings': Buffer.from(`%PDF-1.4\nBT ${'(a) '.repeat(3_000_000)} ET`, 'latin1'),
    'many empty BT ET': Buffer.from(`%PDF-1.4\n${'BT ET '.repeat(2_000_000)}`, 'latin1'),
  };
  for (const [name, pdf] of Object.entries(cases)) {
    assert.ok(pdf.length > 10 * 1024 * 1024, name);
    const { out, ms } = timed(() => extractPdfText(pdf));
    assert.equal(typeof out, 'string', name);
    assert.ok(ms < LIMIT_MS, `${name} took ${ms.toFixed(0)} ms`);
  }
});

test('S4-AI-02: multipart part cap and time budget; legitimate uploads still parse', async () => {
  const { parseMultipart, MAX_MULTIPART_PARTS } = await import('../../../src/modules/evidence/parse.mjs');
  const { multipart } = await import('./helpers.mjs');
  const ct = 'multipart/form-data; boundary=XB';
  const evil = Buffer.from('--XB\r\n\r\n'.repeat(2_000_000), 'latin1');
  assert.ok(evil.length > 15 * 1024 * 1024);
  let err;
  const t0 = performance.now();
  try { parseMultipart(evil, ct); } catch (e) { err = e; }
  const ms = performance.now() - t0;
  assert.ok(ms < LIMIT_MS, `took ${ms.toFixed(0)} ms`);
  assert.equal(err?.status, 400);
  assert.equal(err?.code, 'validation_error');

  const mk = (n) => multipart(Array.from({ length: n }, (_, i) => ({ name: `f${i}`, data: 'x' })));
  const ok = mk(MAX_MULTIPART_PARTS);
  assert.equal(parseMultipart(ok.raw, ok.headers['content-type']).length, MAX_MULTIPART_PARTS);
  const over = mk(MAX_MULTIPART_PARTS + 1);
  assert.throws(() => parseMultipart(over.raw, over.headers['content-type']), { code: 'validation_error', status: 400 });
});
