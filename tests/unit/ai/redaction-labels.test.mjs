import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { redactValue, restore } from '../../../src/ai/guardrails.mjs';

const red = (t) => redactValue({ text: t });

test('labelled names are redacted and restored', () => {
  const r = red('Customer: Morgan Ellis, phone 555-010-4410');
  assert.ok(!r.value.text.includes('Morgan'));
  assert.ok(!r.value.text.includes('4410'));
  assert.equal(restore(r.value, r.map).text, 'Customer: Morgan Ellis, phone 555-010-4410');
});

test('all labels, case-insensitive, with or without colon', () => {
  for (const l of ['Customer', 'Claimant', 'Insured', 'Owner', 'Driver', 'Witness', 'Contact', 'Policyholder', 'Name', 'Cited', 'Reported by', 'Other driver']) {
    for (const t of [`${l}: Jordan Rivera, x`, `${l.toUpperCase()}: Jordan Rivera\nnext`, `${l.toLowerCase()} Jordan Rivera phone 1`, `${l} Jordan Rivera.`]) {
      const o = red(t).value.text;
      assert.ok(!o.includes('Rivera') && !o.includes('Jordan'), `${t} -> ${o}`);
    }
  }
});

test('stops at comma, newline, phone, digits', () => {
  assert.match(red('Owner: Ana Cruz Phone 555-010-1111').value.text, /^Owner: \[NAME_1\] Phone \[PHONE_1\]$/);
  assert.match(red('Driver: Ana Cruz\nVehicle: Maple').value.text, /\nVehicle: Maple$/);
  assert.match(red('Witness: Ana Cruz 2 saw it').value.text, /2 saw it$/);
});

test('golden pii never leaks', () => {
  const dir = new URL('../../fixtures/ai/golden/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    for (const c of JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')).cases) {
      const out = JSON.stringify(redactValue(c.input).value);
      for (const p of c.pii ?? []) assert.ok(!out.includes(p), `${f}/${c.id} leaks ${p}`);
    }
  }
});

test('no over-redaction of shop names and loss types', () => {
  const t = 'Repair Shop: Lakeside Collision Center, loss type: Collision';
  const o = red(t).value.text;
  assert.ok(o.includes('Lakeside Collision Center') && o.includes('Collision'), o);
});

test('50k-char adversarial inputs are linear', () => {
  for (const t of ['Owner ' + 'Aa '.repeat(17000), 'name' + ' '.repeat(50000) + 'x', 'Driver: ' + 'A'.repeat(50000), 'Contact\t'.repeat(6000)]) {
    const t0 = performance.now();
    red(t);
    assert.ok(performance.now() - t0 < 100, `slow: ${performance.now() - t0}`);
  }
});
