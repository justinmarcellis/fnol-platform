import test from 'node:test';
import assert from 'node:assert/strict';
import { bootEvidenceApp, call, textBytes, multipart } from './helpers.mjs';
import { parseMultipart } from '../../../src/modules/evidence/parse.mjs';

const CLAIM = 'clm_00000000000000000001';
const URL = `/api/v1/claims/${CLAIM}/documents`;
const b64 = (s) => Buffer.from(s).toString('base64');

test('base64 JSON upload returns fast with pending extraction, then extraction completes', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const tok = app.token(['claimant']);
  const r = await call(app, 'POST', URL, { token: tok, body: { kind: 'police_report', filename: 'r.txt', contentType: 'text/plain', contentBase64: b64('Police Report\nReport No: PR-77') } });
  assert.equal(r.status, 201);
  assert.equal(r.json.extraction.status, 'pending');
  assert.equal(r.json.source, 'claimant_upload');
  assert.equal(r.json.storageKey, undefined, 'claimants never see storage keys');
  await app.ctx.bus.drain();
  const csr = app.token(['csr']);
  const ex = await call(app, 'GET', `${URL}/${r.json.id}/extraction`, { token: csr });
  assert.equal(ex.status, 200);
  assert.equal(ex.json.fields[0].value, 'PR-77');
  const c = await call(app, 'GET', `${URL}/${r.json.id}`, { token: tok });
  assert.equal(c.json.extraction.fields, undefined, 'claimant sees status only');
});

test('multipart upload (binary safe) with optional kind and metadata', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('\r\n--not-a-boundary\r\n'), Buffer.from([0, 1, 2])]);
  const m = multipart([
    { name: 'metadata', data: JSON.stringify({ damageAreas: ['hood'] }) },
    { name: 'file', filename: 'p.png', type: 'image/png', data: png },
  ]);
  const r = await call(app, 'POST', URL, { token: app.token(['csr']), raw: m.raw, headers: m.headers });
  assert.equal(r.status, 201);
  assert.equal(r.json.kind, 'photo');
  assert.equal(r.json.source, 'csr_upload');
  const dl = await call(app, 'GET', `${URL}/${r.json.id}/content`, { token: app.token(['adjuster']) });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'image/png');
  assert.deepEqual(dl.buf, png);
  await app.ctx.bus.drain();
  assert.equal(app.ai.calls[0].task, 'classify_photo');
  assert.deepEqual(app.ai.calls[0].input.metadata, { damageAreas: ['hood'] });
});

test('parseMultipart handles quoted boundary and missing parts', () => {
  const m = multipart([{ name: 'kind', data: 'photo' }, { name: 'file', filename: 'a.jpg', type: 'image/jpeg', data: Buffer.from([1, 2, 3]) }]);
  const parts = parseMultipart(m.raw, m.headers['content-type']);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].data.toString(), 'photo');
  assert.deepEqual(parts[1].data, Buffer.from([1, 2, 3]));
  assert.equal(parseMultipart(m.raw, 'multipart/form-data'), null);
});

test('error statuses: 415, 413, 400, 401, 403', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const tok = app.token(['csr']);
  const bad = await call(app, 'POST', URL, { token: tok, body: { filename: 'a.exe', contentType: 'application/x-msdownload', contentBase64: b64('x') } });
  assert.equal(bad.status, 415);
  assert.equal(bad.json.error.code, 'unsupported_media_type');
  const big = await call(app, 'POST', URL, { token: tok, body: { filename: 'a.txt', contentType: 'text/plain', contentBase64: Buffer.alloc(10 * 1024 * 1024 + 1, 97).toString('base64') } });
  assert.equal(big.status, 413);
  const noB64 = await call(app, 'POST', URL, { token: tok, body: { filename: 'a.txt', contentType: 'text/plain' } });
  assert.equal(noB64.status, 400);
  const badKind = await call(app, 'POST', URL, { token: tok, body: { kind: 'nope', filename: 'a.txt', contentType: 'text/plain', contentBase64: b64('x') } });
  assert.equal(badKind.status, 400);
  assert.equal((await call(app, 'POST', URL, { body: {} })).status, 401);
  assert.equal((await call(app, 'POST', URL, { token: app.token(['supervisor']), body: { filename: 'a.txt', contentType: 'text/plain', contentBase64: b64('x') } })).status, 403);
});

test('x-roles enforced per route', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const up = await call(app, 'POST', URL, { token: app.token(['csr']), body: { kind: 'other', filename: 'a.txt', contentType: 'text/plain', contentBase64: b64('hello') } });
  const id = up.json.id;
  await app.ctx.bus.drain();
  const R = (roles) => app.token(roles);
  const status = async (method, path, roles, body) => (await call(app, method, `${URL}${path}`, { token: R(roles), body })).status;
  // content: csr, adjuster, supervisor only
  assert.equal(await status('GET', `/${id}/content`, ['claimant']), 403);
  assert.equal(await status('GET', `/${id}/content`, ['supervisor']), 200);
  // list/get: claimant ok (auditor is in openapi x-roles but not in core ROLES)
  assert.equal(await status('GET', `/${id}`, ['claimant']), 200);
  // extraction get excludes claimant
  assert.equal(await status('GET', `/${id}/extraction`, ['claimant']), 403);
  // rerun: adjuster/supervisor only
  assert.equal(await status('POST', `/${id}/extraction`, ['csr']), 403);
  assert.equal(await status('POST', `/${id}/extraction`, ['adjuster']), 202);
  // review: csr/adjuster/supervisor
  const body = { fields: [{ name: 'x', accepted: true }] };
  assert.equal(await status('POST', `/${id}/extraction/review`, ['claimant'], body), 403);
  assert.equal(await status('GET', '/doc_missing', ['csr']), 404);
  await app.ctx.bus.drain();
});

test('list with kind filter, review route, rerun, tenant isolation over HTTP', async (t) => {
  const app = await bootEvidenceApp();
  t.after(() => app.close());
  const csr = app.token(['csr']);
  const mk = (kind, text) => call(app, 'POST', URL, { token: csr, body: { kind, filename: `${kind}.txt`, contentType: 'text/plain', contentBase64: b64(text) } });
  const a = await mk('police_report', 'Police\nReport No: PR-9');
  await mk('invoice', 'Invoice');
  await app.ctx.bus.drain();
  const all = await call(app, 'GET', URL, { token: csr });
  assert.equal(all.json.items.length, 2);
  const filt = await call(app, 'GET', `${URL}?kind=invoice`, { token: csr });
  assert.equal(filt.json.items.length, 1);
  const rev = await call(app, 'POST', `${URL}/${a.json.id}/extraction/review`, { token: csr, body: { fields: [{ name: 'policeReportNumber', accepted: true, value: 'PR-9X' }] } });
  assert.equal(rev.status, 200);
  assert.equal(rev.json.fields[0].value, 'PR-9X');
  assert.equal(rev.json.fields[0].accepted, true);
  assert.equal((await call(app, 'POST', `${URL}/${a.json.id}/extraction/review`, { token: csr, body: {} })).status, 400);
  const other = await call(app, 'GET', `${URL}/${a.json.id}`, { token: app.token(['csr'], 'beta') });
  assert.equal(other.status, 404);
  const calls = app.ai.calls.length;
  await call(app, 'POST', `${URL}/${a.json.id}/extraction`, { token: app.token(['adjuster']) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(app.ai.calls.length, calls + 1);
});
