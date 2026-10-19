import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyBranding, brandingToTokens, setScheme, contrastRatio, readableOn } from '../../../../src/web/shared/theme.js';

function fakeRoot() {
  const style = new Map(); const attrs = new Map();
  return { style: { setProperty: (k, v) => style.set(k, v) }, setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k), style_: style, attrs };
}

test('applyBranding maps hex colors to tokens and picks readable text', () => {
  const root = fakeRoot();
  const r = applyBranding({ branding: { primaryColor: '#0B5CAD', accentColor: '#FFEE00' } }, root);
  assert.equal(root.style_.get('--fx-brand'), '#0b5cad');
  assert.equal(root.style_.get('--fx-on-brand'), '#ffffff');
  assert.equal(root.style_.get('--fx-on-accent'), '#111111');
  assert.deepEqual(r.rejected, []);
});

test('rejects non-hex colors, unsafe fonts and logos', () => {
  const root = fakeRoot();
  const r = applyBranding({ primaryColor: 'red', accentColor: 'url(javascript:1)', fontFamily: 'x;}body{', logoUrl: '//evil.test/a.png' }, root);
  assert.deepEqual(r.rejected.sort(), ['accentColor', 'fontFamily', 'logoUrl', 'primaryColor']);
  assert.equal(root.style_.size, 0);
  assert.equal(brandingToTokens({ primaryColor: '#12345' }).rejected[0], 'primaryColor');
  assert.equal(brandingToTokens({ logoUrl: 'assets/logo.svg' }).vars['--fx-logo-url'], 'url("assets/logo.svg")');
});

test('setScheme sets and clears data-theme', () => {
  const root = fakeRoot();
  assert.equal(setScheme('dark', root), 'dark');
  assert.equal(root.attrs.get('data-theme'), 'dark');
  assert.equal(setScheme('auto', root), 'auto');
  assert.equal(root.attrs.has('data-theme'), false);
});

test('contrast helpers', () => {
  assert.ok(contrastRatio('#000000', '#ffffff') > 20);
  assert.equal(readableOn('#ffffff'), '#111111');
});

function tokensOf(block) {
  return Object.fromEntries([...block.matchAll(/--(fx-[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}
test('tokens.css defines light and dark and text pairs meet 4.5:1', () => {
  const css = readFileSync(new URL('../../../../src/web/shared/tokens.css', import.meta.url), 'utf8');
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /\[data-theme='dark'\]/);
  const light = tokensOf(css.split('@media')[0]);
  const dark = tokensOf(css.slice(css.indexOf(":root[data-theme='dark']")));
  for (const set of [light, dark]) {
    for (const k of ['fx-text', 'fx-text-muted', 'fx-danger', 'fx-success', 'fx-warning']) {
      assert.ok(contrastRatio(set[k], set['fx-bg']) >= 4.5, `${k} on bg`);
      assert.ok(contrastRatio(set[k], set['fx-surface']) >= 4.5, `${k} on surface`);
    }
  }
  assert.ok(contrastRatio(light['fx-brand'], light['fx-on-brand']) >= 4.5);
  assert.ok(contrastRatio(light['fx-accent'], light['fx-on-accent']) >= 4.5);
});
