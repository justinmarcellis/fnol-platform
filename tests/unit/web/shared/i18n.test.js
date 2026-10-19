import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, setLocale, getLocale, registerStrings, supportedLocales, kitTables, resolveText } from '../../../../src/web/shared/i18n.js';

test('en and es have identical key sets', () => {
  const { en, es } = kitTables();
  assert.deepEqual(Object.keys(en).sort(), Object.keys(es).sort());
  for (const k of Object.keys(en)) {
    assert.ok(es[k].length > 0);
    const ph = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    assert.equal(ph(es[k]), ph(en[k]), `placeholders differ for ${k}`);
  }
});

test('interpolation, locale switch, fallback', () => {
  assert.deepEqual(supportedLocales.slice(0, 2), ['en', 'es']);
  setLocale('en');
  assert.equal(t('kit.stepper.stepOf', { current: 2, total: 5 }), 'Step 2 of 5');
  assert.equal(t('kit.field.required'), '{label} is required.');
  assert.equal(setLocale('es-MX'), 'es');
  assert.equal(getLocale(), 'es');
  assert.equal(t('common.submit'), 'Enviar');
  registerStrings('en', { 'claimant.only': 'English only' });
  assert.equal(t('claimant.only'), 'English only');
  assert.equal(t('missing.key'), 'missing.key');
  assert.equal(setLocale('fr'), 'en');
});

test('resolveText handles strings and maps', () => {
  setLocale('es');
  assert.equal(resolveText({ en: 'a', es: 'b' }), 'b');
  assert.equal(resolveText({ en: 'a' }), 'a');
  assert.equal(resolveText('x'), 'x');
  setLocale('en');
});
