import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadInbox, loadView, submitDecision, addNote, loadChecklist, saveChecklist } from '../../../../src/web/adjuster/actions.js';
import { fakeView } from './fixtures.mjs';

function fakeApi() {
  const calls = [];
  const rec = (method) => async (path, body) => { calls.push({ method, path, body }); return { id: 'n1', ...body }; };
  return { calls, get: rec('GET'), post: rec('POST'), patch: rec('PATCH') };
}

test('loadInbox and loadView hit the adjuster endpoints', async () => {
  const api = fakeApi();
  await loadInbox(api, { mine: false });
  await loadView(api, 'clm 1');
  assert.deepEqual(api.calls[0], { method: 'GET', path: '/adjuster/inbox', body: { mine: false, limit: 50 } });
  assert.equal(api.calls[1].path, '/adjuster/claims/clm%201/view');
});

test('submitDecision rejects an empty note without calling the API', async () => {
  const api = fakeApi();
  const r = await submitDecision(api, 'c1', { kind: 'fraud', action: 'accepted', note: '', tasks: [] });
  assert.equal(r.ok, false);
  assert.equal(api.calls.length, 0);
});

test('submitDecision posts a categorised note and updates the task', async () => {
  const api = fakeApi();
  const r = await submitDecision(api, 'c1', { kind: 'fraud', action: 'dismissed', note: 'Receipts check out', tasks: fakeView().tasks });
  assert.equal(r.ok, true);
  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ['POST /claims/c1/notes', 'PATCH /claims/c1/tasks/tsk1']);
  assert.equal(api.calls[0].body.category, 'fraud');
  assert.equal(api.calls[0].body.body, '[decision:dismissed] Receipts check out');
  assert.deepEqual(api.calls[1].body, { status: 'cancelled' });
});

test('a failing task update does not lose the recorded decision', async () => {
  const api = fakeApi();
  api.patch = async () => { throw new Error('boom'); };
  const r = await submitDecision(api, 'c1', { kind: 'subrogation', action: 'accepted', note: 'Pursue', tasks: fakeView().tasks });
  assert.equal(r.ok, true);
});

test('addNote trims and posts a general internal note', async () => {
  const api = fakeApi();
  await addNote(api, 'c1', '  hello ');
  assert.deepEqual(api.calls[0].body, { body: 'hello', category: 'general', visibility: 'internal' });
});

test('checklist persistence survives blocked storage', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  saveChecklist('c1', ['a', 'b'], storage);
  assert.deepEqual(loadChecklist('c1', storage), ['a', 'b']);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadChecklist('c1', blocked), []);
  assert.doesNotThrow(() => saveChecklist('c1', ['a'], blocked));
});
