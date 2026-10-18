// S2-SEC-01: uploads, parsing and AI-layer findings. Tests named SEC2-NNN assert the SECURE behaviour and are
// marked t.todo until fixed. Unmarked tests are regression guards for controls that hold today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractPdfText } from '../../src/modules/evidence/parse.mjs';
import { isSafeRegex } from '../../src/modules/rules/condition.js';
import { computeSeverity } from '../../src/modules/triage/severity.mjs';
import { mergeFraud } from '../../src/modules/triage/fraud.mjs';
import { bootReal, call, createClaimWithPii, timed, PII, T1 } from './sec2-helpers.mjs';

const BUDGET_MS = 300;

test('SEC2-005: PDF text extraction is bounded (quadratic regex scans and unbounded inflate)', async (t) => {
  t.todo('SEC2-005: extractPdfText scans BT/stream with lazy regexes (O(n^2)) and inflates streams without a size cap');
  const bt = Buffer.from('BT '.repeat(40000), 'latin1'); // 120 KB with no ET
  const stream = Buffer.from('stream\n'.repeat(20000), 'latin1'); // 140 KB with no endstream
  const bomb = Buffer.concat([Buffer.from('%PDF-1.4\nstream\n', 'latin1'), zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024)), Buffer.from('\nendstream\n', 'latin1')]);
  const results = { bt: timed(() => extractPdfText(bt)), stream: timed(() => extractPdfText(stream)), bomb: timed(() => extractPdfText(bomb)) };
  for (const [k, ms] of Object.entries(results)) assert.ok(ms < BUDGET_MS, `${k} input took ${Math.round(ms)} ms to parse (budget ${BUDGET_MS} ms)`);
});

test('SEC2-006: the contentBase64 validity check cannot be used to stall the event loop', async (t) => {
  t.todo('SEC2-006: /^[A-Za-z0-9+/\\s]*={0,2}\\s*$/ backtracks quadratically on whitespace followed by an invalid character');
  const app = await bootReal();
  try {
    const id = await createClaimWithPii(app, T1, 'A');
    const hostile = `${' '.repeat(25000)}!`;
    const t0 = performance.now();
    const r = await call(app, 'POST', `/api/v1/claims/${id}/documents`, {
      token: app.as(T1, ['claimant'], 'sec2-any'), body: { filename: 'a.png', contentType: 'image/png', contentBase64: hostile },
    });
    const ms = performance.now() - t0;
    assert.equal(r.status, 400);
    assert.ok(ms < BUDGET_MS, `request took ${Math.round(ms)} ms (budget ${BUDGET_MS} ms)`);
  } finally { await app.close(); }
});

test('SEC2-009: AI output is type-checked against the task schema, not only for top-level keys', async (t) => {
  t.todo('SEC2-009: hasRequiredShape only checks that required keys exist, so wrong types reach consumers (adjuster summary 500s)');
  const app = await bootReal();
  try {
    const evil = { async available() { return true; }, async run() { return { output: { score: 'DROP', band: { x: 1 }, drivers: 'not-an-array' }, confidence: 0.99, explanation: 'x' }; } };
    let accepted = true;
    try { await app.ctx.forTenant(T1).ai.run('severity', { facts: {} }, { providers: { local: evil } }); } catch { accepted = false; }
    assert.equal(accepted, false, 'a severity output with string score and object band was accepted');
  } finally { await app.close(); }
});

test('SEC2-010: AI calls made through a tenant-bound ctx are attributed to the tenant (inference log, tenant AI config)', async (t) => {
  t.todo('SEC2-010: intake conversation.js calls ctx.ai.run without opts.tenantId; the root ai object has no ctx.tenant, so the call is unlogged and ignores tenant ai settings');
  const app = await bootReal();
  try {
    const before = app.ctx.ai.log.list(T1).length;
    await app.ctx.forTenant(T1).ai.run('extract_narrative', { text: 'I was rear-ended yesterday' });
    assert.equal(app.ctx.ai.log.list(T1).length, before + 1, 'tenant-bound ai.run left no inference row');
  } finally { await app.close(); }
});

test('SEC2-012: facts from a claimant-uploaded document are not auto-accepted into triage', async (t) => {
  t.todo('SEC2-012: getAcceptedFacts trusts any AI field with confidence >= 0.8, so claimant text drives subrogation indicators');
  const app = await bootReal();
  try {
    const id = await createClaimWithPii(app, T1, 'A');
    const r = await call(app, 'POST', `/api/v1/claims/${id}/documents`, {
      token: app.as(T1, ['claimant'], 'sec2-any'),
      body: { filename: 'note.txt', kind: 'police_report', contentType: 'text/plain', contentBase64: Buffer.from('Police report no: PR-777777\nat-fault: other driver\ncited: Driver 2').toString('base64') },
    });
    assert.equal(r.status, 201);
    await app.ctx.bus.drain();
    const facts = await app.ctx.forTenant(T1).modules.evidence.getAcceptedFacts(id);
    assert.deepEqual(Object.keys(facts), [], 'unreviewed claimant-sourced extraction fields were accepted as facts');
  } finally { await app.close(); }
});

test('SEC2-013: isSafeRegex rejects ambiguous alternation under a quantifier', async (t) => {
  t.todo('SEC2-013: the nested-quantifier heuristic misses (a|aa)+$ and (\\w|\\d)+x$, so tenant rules can freeze the process');
  for (const p of ['(a|aa)+$', '(a|a)*b', '(\\w|\\d)+x$']) assert.equal(isSafeRegex(p), false, `${p} is accepted as safe`);
});

test('SEC2-015: webhook subscriptions respect the tenant notifications.webhooks.allowedHosts list', async (t) => {
  t.todo('SEC2-015: allowedHosts is in TenantConfig but never read; any public https host is accepted');
  const app = await bootReal();
  try {
    const r = await call(app, 'POST', '/api/v1/integrations/webhooks', {
      token: app.as(T1, ['tenant_admin'], 'sec2-adm'), body: { url: 'https://evil.example.com/hook', eventTypes: ['claim.reported'] },
    });
    assert.equal(r.status, 422, `a host outside allowedHosts was accepted (${r.status})`);
  } finally { await app.close(); }
});

test('SEC2-018: uploaded bytes must match the declared content type (fixed in tree during the review)', async () => {
  const app = await bootReal();
  try {
    const id = await createClaimWithPii(app, T1, 'A');
    const r = await call(app, 'POST', `/api/v1/claims/${id}/documents`, {
      token: app.as(T1, ['csr'], 'sec2-csr'), body: { filename: 'x.png', contentType: 'image/png', contentBase64: Buffer.from('<html><script>alert(1)</script></html>').toString('base64') },
    });
    assert.equal(r.status, 415, `HTML masquerading as image/png was accepted (${r.status})`);
  } finally { await app.close(); }
});

test('SEC2-022: a user id equal to the triage system actor does not bypass the terminal-state guard', async (t) => {
  t.todo('SEC2-022: triage compares the caller\'s sub to the string "system:triage"');
  const app = await bootReal();
  try {
    const id = await createClaimWithPii(app, T1, 'A');
    await call(app, 'POST', `/api/v1/claims/${id}/status`, { token: app.as(T1, ['supervisor'], 'sec2-sup'), body: { to: 'withdrawn', reason: 'test' } });
    const r = await call(app, 'POST', `/api/v1/claims/${id}/triage`, { token: app.as(T1, ['adjuster'], 'system:triage'), body: { force: true } });
    assert.equal(r.status, 409);
  } finally { await app.close(); }
});

// ---- controls that hold today (regression guards) -------------------------------------------------------

test('sec2: uploads enforce the type allowlist and size cap, and filenames never reach the filesystem path', async () => {
  const app = await bootReal();
  try {
    const id = await createClaimWithPii(app, T1, 'A');
    const csr = app.as(T1, ['csr'], 'sec2-csr');
    const svg = await call(app, 'POST', `/api/v1/claims/${id}/documents`, { token: csr, body: { filename: 'a.svg', contentType: 'image/svg+xml', contentBase64: Buffer.from('<svg/>').toString('base64') } });
    assert.equal(svg.status, 415);
    const html = await call(app, 'POST', `/api/v1/claims/${id}/documents`, { token: csr, body: { filename: 'a.html', contentType: 'text/html', contentBase64: Buffer.from('<p>').toString('base64') } });
    assert.equal(html.status, 415);
    const big = await call(app, 'POST', `/api/v1/claims/${id}/documents`, { token: csr, body: { filename: 'big.txt', contentType: 'text/plain', contentBase64: Buffer.alloc(10 * 1024 * 1024 + 1, 97).toString('base64') } });
    assert.equal(big.status, 413);
    const evil = await call(app, 'POST', `/api/v1/claims/${id}/documents`, {
      token: csr, body: { filename: '../../../../etc/passwd', contentType: 'text/plain', contentBase64: Buffer.from('hello').toString('base64') },
    });
    assert.equal(evil.status, 201);
    const meta = await call(app, 'GET', `/api/v1/claims/${id}/documents/${evil.json.id}`, { token: app.as(T1, ['supervisor'], 'sec2-sup') });
    assert.ok(!meta.json.storageKey.includes('..'), 'storage key must not be derived from the filename');
    assert.match(meta.json.storageKey, new RegExp(`^${T1}/${id}/doc_`));
    const blobRoot = path.join(path.dirname(app.ctx.config.dbPath), 'blobs');
    assert.ok(fs.existsSync(path.join(blobRoot, meta.json.storageKey)), 'blob lives under the tenant-prefixed blob root');
    const raw = fs.readFileSync(path.join(blobRoot, meta.json.storageKey));
    assert.ok(!raw.includes('hello'), 'blobs are encrypted at rest');
    const c = await fetch(`${app.url}/api/v1/claims/${id}/documents/${evil.json.id}/content`, { headers: { authorization: `Bearer ${csr}` } });
    assert.equal(c.headers.get('x-content-type-options'), 'nosniff');
    const claimantContent = await call(app, 'GET', `/api/v1/claims/${id}/documents/${evil.json.id}/content`, { token: app.as(T1, ['claimant'], 'sec2-any') });
    assert.equal(claimantContent.status, 403, 'claimants cannot download stored content');
  } finally { await app.close(); }
});

test('sec2: triage clamps AI severity and fraud outputs, so a hostile model cannot push values out of range', () => {
  const sev = computeSeverity({ score: 1e9, drivers: [] }, [], {});
  assert.equal(sev.score, 100);
  const low = computeSeverity({ score: -500, drivers: [] }, [], {});
  assert.equal(low.score, 0);
  const nan = computeSeverity({ score: 'DROP', drivers: [] }, [], {});
  assert.ok(nan.score >= 0 && nan.score <= 100);
  const fraud = mergeFraud([], { indicators: [{ code: 'X', weight: 1e6 }, { code: 'Y', weight: -5 }] });
  assert.ok(fraud.score <= 100 && fraud.score >= 0);
});

test('sec2: the AI inference log stores a hash of the input, never the raw text', async () => {
  const app = await bootReal();
  try {
    const text = `${PII.A.fullName} lives at ${PII.A.address} and was rear-ended`;
    await app.ctx.ai.run('extract_narrative', { text }, { tenantId: T1 });
    const rows = app.ctx.ai.log.list(T1);
    assert.ok(rows.length >= 1);
    assert.match(rows[0].input_hash, /^[0-9a-f]{64}$/);
    const dump = JSON.stringify(app.ctx.db.raw.prepare('SELECT * FROM ai_inference').all());
    assert.ok(!dump.includes(PII.A.fullName) && !dump.includes(PII.A.address));
  } finally { await app.close(); }
});

test('sec2: triage facts passed to the AI layer carry no names, addresses or free text', async () => {
  const { buildTriageFacts } = await import('../../src/modules/triage/facts.mjs');
  const facts = buildTriageFacts({
    bundle: {
      claim: { lob: 'personal_auto', lossEvent: { lossDate: '2026-10-01', cause: 'collision', description: `${PII.A.fullName} at ${PII.A.address}, plate ${PII.A.plate}` }, reportedAt: '2026-10-02T00:00:00Z' },
      parties: [{ firstName: 'Zephyrine', lastName: 'Quillfeather', phone: PII.A.phone, driversLicense: PII.A.license }], vehicles: [{ licensePlate: PII.A.plate }],
    },
    accepted: { citedParty: { value: 'Zephyrine Quillfeather' }, atFaultParty: { value: 'Thaddeus Marblewick' } },
  });
  const s = JSON.stringify(facts);
  for (const v of [...Object.values(PII.A), 'Zephyrine', 'Quillfeather', 'Marblewick']) assert.ok(!s.includes(v), `triage facts include ${v}`);
});

test('sec2: the intake question mapper ignores prototype-polluting paths', async () => {
  const { toClaimCreate } = await import('../../src/modules/intake/mapping.js');
  const qs = [{ id: 'q1', type: 'text', mapsTo: 'loss.__proto__.polluted' }, { id: 'q2', type: 'text', mapsTo: 'parties[role=driver].constructor.prototype.x' }];
  toClaimCreate({ id: 's', lob: 'personal_auto', channel: 'api' }, { q1: { value: 'x' }, q2: { value: 'y' } }, qs, {});
  assert.equal({}.polluted, undefined);
  assert.equal({}.x, undefined);
});
