import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeFlow } from '../../../../src/web/claimant/flow.js';
import { createUploader, validateFile, MAX_BYTES } from '../../../../src/web/claimant/upload.js';
import { createStatusPoller } from '../../../../src/web/claimant/status.js';
import { claimantStrings, localText } from '../../../../src/web/claimant/strings.js';
import { fakeApi, fakeTimers, FakeApiError, step, q } from './helpers.mjs';

const file = (name = 'dent.jpg', type = 'image/jpeg', bytes = 10) => new File([new Uint8Array(bytes)], name, { type });

test('submit -> claim number -> upload -> status polling', async () => {
  let statusCalls = 0;
  const api = fakeApi({
    'POST /intake/sessions': step({ question: null, done: true }),
    'POST /intake/sessions/:id/submit': { id: 'c9', claimNumber: 'KES-2026-000042', status: 'reported' },
    'POST /claims/:id/documents': (form) => ({ id: 'd1', kind: form.get('kind'), filename: form.get('file').name }),
    'GET /claims/c9': () => ({ id: 'c9', status: ++statusCalls > 1 ? 'closed' : 'reported' })
  });
  const flow = createIntakeFlow({ api });
  await flow.start({ lob: 'personal_auto' });
  const claim = await flow.submit();
  assert.equal(claim.claimNumber, 'KES-2026-000042');
  assert.equal(flow.state.claim.claimNumber, 'KES-2026-000042');

  const up = createUploader({ api, claimId: claim.id });
  await up.add(file());
  assert.equal(up.items[0].status, 'done');
  const call = api.calls.find((c) => c.method === 'UPLOAD');
  assert.equal(call.path, '/claims/c9/documents');
  assert.equal(call.body.get('kind'), 'photo');

  const timers = fakeTimers();
  const poller = createStatusPoller({ api, claimId: claim.id, timers });
  await poller.start();
  await timers.fireNext();
  assert.equal(poller.state.final, true);
  assert.equal(timers.count, 0);
});

test('upload validation rejects oversize and unsupported files without calling the API', async () => {
  const api = fakeApi({});
  const up = createUploader({ api, claimId: 'c1' });
  await up.add({ name: 'big.pdf', size: MAX_BYTES + 1, type: 'application/pdf' });
  await up.add(file('x.exe', 'application/x-msdownload'));
  assert.deepEqual(up.items.map((i) => i.code), ['tooLarge', 'badType']);
  assert.equal(api.calls.length, 0);
  assert.equal(validateFile(file()).ok, true);
});

test('upload failure is retryable', async () => {
  let fail = true;
  const api = fakeApi({ 'POST /claims/c1/documents': () => { if (fail) throw new FakeApiError(0, 'service_unavailable', 'down'); return { id: 'd2' }; } });
  const up = createUploader({ api, claimId: 'c1' });
  await up.add(file('a.png', 'image/png'));
  assert.equal(up.items[0].status, 'error');
  fail = false;
  await up.retry(up.items[0].id);
  assert.equal(up.items[0].status, 'done');
});

test('strings: en and es have identical keys; localText falls back', () => {
  assert.deepEqual(Object.keys(claimantStrings.es).sort(), Object.keys(claimantStrings.en).sort());
  assert.equal(localText({ en: 'Hi', es: 'Hola' }, 'es'), 'Hola');
  assert.equal(localText({ en: 'Hi' }, 'es-MX'), 'Hi');
  assert.equal(localText('Plain', 'es'), 'Plain');
});
