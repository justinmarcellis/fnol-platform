import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerComponents, elements } from '../../../../src/web/shared/components/index.js';
import { validateField } from '../../../../src/web/shared/components/field.js';
import { toggleSelection, nextIndex } from '../../../../src/web/shared/components/chips.js';
import { stepStates, goTo } from '../../../../src/web/shared/components/stepper.js';
import { acceptsType, validateFiles, FxUpload } from '../../../../src/web/shared/components/upload.js';
import { makeMessage } from '../../../../src/web/shared/components/chat.js';
import { sortEvents, formatWhen } from '../../../../src/web/shared/components/timeline.js';
import { pushToast, dismissToast } from '../../../../src/web/shared/components/toast.js';
import { sortRows, nextSort } from '../../../../src/web/shared/components/table.js';
import { setLocale } from '../../../../src/web/shared/i18n.js';

test('index registers eight elements with a registry, and is a no-op without DOM', () => {
  assert.equal(registerComponents(null), 0);
  const defined = new Map();
  const reg = { get: (n) => defined.get(n), define: (n, c) => defined.set(n, c) };
  assert.equal(registerComponents(reg), 8);
  assert.equal(registerComponents(reg), 0);
  assert.deepEqual([...defined.keys()].sort(), Object.keys(elements).sort());
});

test('validateField', () => {
  setLocale('en');
  assert.equal(validateField('', { label: 'Name', required: true }), 'Name is required.');
  assert.equal(validateField('', { label: 'Name' }), null);
  assert.match(validateField('ab', { label: 'N', minLength: 3 }), /at least 3/);
  assert.match(validateField('abcd', { label: 'N', maxLength: 3 }), /at most 3/);
  assert.match(validateField('x', { label: 'Zip', pattern: '^\\d{5}$' }), /not valid/);
  assert.equal(validateField('12345', { pattern: '^\\d{5}$' }), null);
});

test('chips logic', () => {
  assert.deepEqual(toggleSelection(['a'], 'b', false), ['b']);
  assert.deepEqual(toggleSelection(['a'], 'b', true), ['a', 'b']);
  assert.deepEqual(toggleSelection(['a', 'b'], 'a', true), ['b']);
  assert.equal(nextIndex(2, 'ArrowRight', 3), 0);
  assert.equal(nextIndex(0, 'ArrowLeft', 3), 2);
  assert.equal(nextIndex(1, 'Home', 3), 0);
  assert.equal(nextIndex(1, 'End', 3), 2);
  assert.equal(nextIndex(1, 'a', 3), null);
});

test('stepper logic', () => {
  assert.deepEqual(stepStates(3, 1), ['complete', 'current', 'upcoming']);
  assert.equal(goTo(3, 9), 2);
  assert.equal(goTo(3, -1), 0);
});

test('upload validation', () => {
  assert.ok(acceptsType({ type: 'image/png', name: 'a.png' }, 'image/*'));
  assert.ok(acceptsType({ type: '', name: 'a.HEIC' }, '.heic'));
  assert.ok(!acceptsType({ type: 'text/plain', name: 'a.txt' }, 'image/*,application/pdf'));
  const big = { name: 'big.png', type: 'image/png', size: 30 * 1024 * 1024 };
  const ok = { name: 'ok.png', type: 'image/png', size: 10 };
  const bad = { name: 'x.exe', type: 'application/x-msdownload', size: 10 };
  const r = validateFiles([big, ok, bad], { accept: 'image/*', maxSizeMb: 25, max: 10 });
  assert.deepEqual(r.accepted, [ok]);
  assert.equal(r.errors.length, 2);
  assert.match(validateFiles([ok, ok], { max: 1 }).errors[0], /at most 1/);
});

test('upload revokes object URLs on remove and disconnect', () => {
  const created = []; const revoked = [];
  globalThis.URL.createObjectURL = (f) => { const u = `blob:${created.length}`; created.push(u); return u; };
  globalThis.URL.revokeObjectURL = (u) => revoked.push(u);
  const up = new FxUpload();
  up.render = () => {}; up.dispatchEvent = () => true;
  up.getAttribute = () => null;
  const f1 = { name: 'a.png', type: 'image/png', size: 1 }; const f2 = { name: 'b.jpg', type: 'image/jpeg', size: 1 };
  globalThis.CustomEvent ??= class { constructor(t, i) { this.type = t; Object.assign(this, i); } };
  up.add([f1, f2]);
  assert.equal(created.length, 2);
  up.remove(f1);
  assert.deepEqual(revoked, ['blob:0']);
  up.disconnectedCallback();
  assert.deepEqual(revoked, ['blob:0', 'blob:1']);
  assert.equal(up.files.length, 1);
});

test('chat, timeline, toast, table pure logic', () => {
  const m = makeMessage('user', 'hi');
  assert.equal(m.role, 'user'); assert.ok(m.id);
  const ev = [{ at: '2026-01-01T00:00:00Z', title: 'a' }, { at: '2026-02-01T00:00:00Z', title: 'b' }, { at: 'bad', title: 'c' }];
  assert.deepEqual(sortEvents(ev).map((e) => e.title), ['b', 'a', 'c']);
  assert.deepEqual(sortEvents(ev, 'asc').map((e) => e.title), ['c', 'a', 'b']);
  assert.match(formatWhen('2026-01-01T15:00:00Z', 'en'), /Jan 1, 2026/);
  assert.equal(formatWhen('nope'), 'nope');
  let list = [];
  for (let i = 0; i < 6; i++) list = pushToast(list, { id: `i${i}`, message: `m${i}` }, 4);
  assert.deepEqual(list.map((x) => x.id), ['i2', 'i3', 'i4', 'i5']);
  assert.equal(pushToast([], { kind: 'error', message: 'x' })[0].timeout, 0);
  assert.equal(dismissToast(list, 'i3').length, 3);
  const rows = [{ n: 10, s: 'b' }, { n: 2, s: 'a' }, { n: null, s: 'c' }];
  assert.deepEqual(sortRows(rows, 'n').map((r) => r.s), ['a', 'b', 'c']);
  assert.deepEqual(sortRows(rows, 'n', 'desc').map((r) => r.s), ['c', 'b', 'a']);
  assert.deepEqual(sortRows(rows, 's', 'desc').map((r) => r.s), ['c', 'b', 'a']);
  assert.deepEqual(nextSort(null, 'a'), { key: 'a', dir: 'asc' });
  assert.deepEqual(nextSort({ key: 'a', dir: 'asc' }, 'a'), { key: 'a', dir: 'desc' });
});
