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

// ---- Design system v2 (S6-EXP-01) ----
function v2Sets() {
  const css = readFileSync(new URL('../../../../src/web/shared/tokens.css', import.meta.url), 'utf8');
  const light = tokensOf(css.split('@media')[0]);
  const darkMedia = tokensOf(css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf('@media (prefers-reduced-motion')));
  const dark = { ...light, ...tokensOf(css.slice(css.indexOf(":root[data-theme='dark']"))) };
  return { css, light, dark, darkMedia };
}

test('v2: text and semantic pairs meet 4.5:1 on every surface; control borders 3:1 (light and dark)', () => {
  const { light, dark } = v2Sets();
  for (const [name, set] of [['light', light], ['dark', dark]]) {
    for (const fg of ['fx-text', 'fx-text-muted', 'fx-text-subtle', 'fx-success', 'fx-warning', 'fx-danger', 'fx-info', 'fx-neutral']) {
      for (const bg of ['fx-bg', 'fx-surface', 'fx-canvas']) assert.ok(contrastRatio(set[fg], set[bg]) >= 4.5, `${name} ${fg} on ${bg}`);
    }
    for (const k of ['success', 'warning', 'danger', 'info', 'neutral']) assert.ok(contrastRatio(set[`fx-${k}`], set[`fx-${k}-subtle`]) >= 4.5, `${name} ${k} badge`);
    for (const bg of ['fx-bg', 'fx-surface', 'fx-canvas']) assert.ok(contrastRatio(set['fx-border'], set[bg]) >= 3, `${name} border on ${bg}`);
    assert.ok(contrastRatio(set['fx-focus'], set['fx-bg']) >= 3, `${name} focus`);
    assert.ok(contrastRatio(set['fx-demo-fg'], set['fx-demo-bg']) >= 4.5, `${name} demo band`);
    assert.ok(contrastRatio(set['fx-demo-muted'], set['fx-demo-bg']) >= 4.5, `${name} demo muted`);
  }
});

test('v2: dark media block and [data-theme=dark] block define the same values', () => {
  const { css, darkMedia } = v2Sets();
  const explicit = tokensOf(css.slice(css.indexOf(":root[data-theme='dark']")));
  assert.deepEqual(darkMedia, explicit);
});

test('v2: tokens cover type, spacing, radius, elevation, motion and density; no external URLs', () => {
  const { css } = v2Sets();
  for (const t of ['--fx-fs-xs', '--fx-fs-3xl', '--fx-space-9', '--fx-radius-lg', '--fx-shadow-lg', '--fx-dur', '--fx-ease', '--fx-control-h', '--fx-row-h', '--fx-demo-height', '--fx-font-ui']) assert.match(css, new RegExp(`${t}:`), t);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\[data-density='compact'\]/);
  const comp = readFileSync(new URL('../../../../src/web/shared/components.css', import.meta.url), 'utf8');
  for (const s of [css, comp]) { assert.doesNotMatch(s, /@import|url\(\s*['"]?https?:/i); assert.doesNotMatch(s, /@font-face/); }
  assert.match(comp, /:focus-visible \{ outline: 2px solid var\(--fx-focus\)/);
});

test('v2: tenant brands in tenants/*.json keep readable button text', () => {
  for (const hex of ['#1f5f4a', '#243b6b']) assert.ok(contrastRatio(hex, readableOn(hex)) >= 4.5, hex);
});
