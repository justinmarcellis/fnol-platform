import test from 'node:test';
import assert from 'node:assert/strict';
import { bootEvidenceApp, call, makeFakeAi } from './helpers.mjs';

const CLAIM = 'clm_00000000000000000001';
const URL = `/api/v1/claims/${CLAIM}/documents`;
const TEXT = 'Police report no: PR-12345 Cited: Mallory Fictionton';
const ai = () => makeFakeAi({
  extract_document: async () => ({
    output: {
      kind: 'police_report', needsReview: false,
      fields: [
        { name: 'policeReportNumber', value: 'PR-12345', confidence: 0.95, provenance: { snippet: TEXT } },
        { name: 'citedParty', value: 'Mallory Fictionton', confidence: 0.9, provenance: { snippet: 'Cited: Mallory Fictionton' } },
        { name: 'estimateTotal', value: 100, confidence: 0.9, provenance: { snippet: 'Total: 100' } },
      ],
    },
    provider: 'local', model: 'fake-v1', confidence: 0.9, explanation: 'Report cites Mallory Fictionton', usage: {},
  }),
});

async function upload(app) {
  const r = await call(app, 'POST', URL, { token: app.token(['csr']), body: { kind: 'police_report', filename: 'r.txt', contentType: 'text/plain', contentBase64: Buffer.from(TEXT).toString('base64') } });
  assert.equal(r.status, 201);
  await app.ctx.bus.drain();
  return r.json.id;
}

test('auditor and integration never see pii values or spans containing them', async (t) => {
  const app = await bootEvidenceApp({ ai: ai() });
  t.after(() => app.close());
  const id = await upload(app);
  for (const role of ['auditor', 'integration']) {
    const ex = await call(app, 'GET', `${URL}/${id}/extraction`, { token: app.token([role]) });
    assert.equal(ex.status, 200);
    assert.ok(!JSON.stringify(ex.json).includes('Fictionton') && !JSON.stringify(ex.json).includes('Mallory'), `${role} leaks name`);
    const num = ex.json.fields.find((f) => f.name === 'policeReportNumber');
    assert.equal(num.value, 'PR-12345');
    assert.equal(num.provenance.span, undefined);
    assert.equal(num.provenance.documentId, id);
    const cited = ex.json.fields.find((f) => f.name === 'citedParty');
    assert.equal(cited.value, '[redacted]');
    assert.equal(cited.provenance.span, undefined);
    // allow-list: no free text at all, even for non-pii fields
    const total = ex.json.fields.find((f) => f.name === 'estimateTotal');
    assert.equal(total.value, 100);
    assert.equal(total.provenance.span, undefined);
    assert.equal(total.provenance.snippet, undefined);
    assert.equal(ex.json.summary, undefined);
    for (const f of ex.json.fields) for (const [k, v] of Object.entries(f.provenance)) assert.ok(k === 'documentId' || typeof v === 'number', `${role} provenance.${k} not allow-listed`);
  }
});

test('document GET also masks for auditor; adjuster and supervisor views are unchanged', async (t) => {
  const app = await bootEvidenceApp({ ai: ai() });
  t.after(() => app.close());
  const id = await upload(app);
  const doc = await call(app, 'GET', `${URL}/${id}`, { token: app.token(['auditor']) });
  assert.ok(!JSON.stringify(doc.json).includes('Fictionton'));
  for (const role of ['adjuster', 'supervisor']) {
    const ex = await call(app, 'GET', `${URL}/${id}/extraction`, { token: app.token([role]) });
    const num = ex.json.fields.find((f) => f.name === 'policeReportNumber');
    assert.equal(num.provenance.span, TEXT);
    assert.equal(ex.json.fields.find((f) => f.name === 'citedParty').value, 'Mallory Fictionton');
    assert.match(ex.json.summary, /Fictionton/);
  }
});

test('auditor and integration get no free text even for pii never extracted as a field', async (t) => {
  const THIRD = 'Third Name-Only Persona';
  const app = await bootEvidenceApp({ ai: makeFakeAi({
    extract_document: async () => ({
      output: { kind: 'police_report', needsReview: false, fields: [
        { name: 'policeReportNumber', value: 'PR-12345', confidence: 0.95, provenance: { span: `PR-12345 witness ${THIRD}`, snippet: `witness ${THIRD}`, page: 2, offset: 14, note: THIRD } },
      ] },
      provider: 'local', model: 'fake-v1', confidence: 0.9, explanation: `saw ${THIRD}`, usage: {},
    }),
  }) });
  t.after(() => app.close());
  const id = await upload(app);
  for (const role of ['auditor', 'integration']) {
    const ex = await call(app, 'GET', `${URL}/${id}/extraction`, { token: app.token([role]) });
    assert.ok(!JSON.stringify(ex.json).includes('Persona'), `${role} leaks third name`);
    const f = ex.json.fields[0];
    assert.equal(f.provenance.documentId, id);
    for (const [k, v] of Object.entries(f.provenance)) assert.ok(k === 'documentId' || typeof v === 'number', `provenance.${k} not allow-listed`);
    assert.equal(f.value, 'PR-12345');
    assert.equal(f.confidence, 0.95);
  }
});
