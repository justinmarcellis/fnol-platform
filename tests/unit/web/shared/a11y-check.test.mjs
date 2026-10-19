import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  contrastRatio, checkTokens, parseTokensCss, checkBranding, checkDocument, reportWarnings, TOKEN_PAIRS,
} from '../../../../src/web/shared/a11y-check.js';

// Minimal fake DOM: tag names, [attr] selectors, tag[attr] and comma lists are all the checks need.
function el(tag, attrs = {}, kids = [], textContent = '') {
  const node = {
    tagName: tag.toUpperCase(), id: attrs.id || '', attrs, children: kids, parentElement: null, textContent: textContent || kids.map((k) => k.textContent).join(''),
    getAttribute: (n) => (n in attrs ? String(attrs[n]) : null),
    hasAttribute: (n) => n in attrs,
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; },
    querySelectorAll(sel) {
      const parts = sel.split(',').map((s) => s.trim());
      const found = [];
      const walk = (n) => { for (const k of n.children) { if (parts.some((p) => matches(k, p))) found.push(k); walk(k); } };
      walk(this);
      return found;
    },
  };
  for (const k of kids) k.parentElement = node;
  return node;
}
function matches(n, sel) {
  const m = /^([a-z0-9]*)(?:\[([a-z-]+)(?:="([^"]*)")?\])?$/i.exec(sel);
  if (!m) return false;
  if (m[1] && n.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
  if (m[2] && !(m[2] in n.attrs)) return false;
  if (m[3] !== undefined && n.attrs[m[2]] !== m[3]) return false;
  return true;
}
const doc = (...kids) => { const root = el('html', { lang: 'en' }, kids); root.documentElement = root; return root; };

test('contrastRatio matches known WCAG values', () => {
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrastRatio('#fff', '#fff').toFixed(2), '1.00');
  assert.ok(contrastRatio('#777777', '#ffffff') < 4.5);
  assert.ok(contrastRatio('#767676', '#ffffff') >= 4.5);
  assert.ok(Number.isNaN(contrastRatio('red', '#ffffff')));
});

test('checkTokens warns on low contrast pairs and skips missing ones', () => {
  const ok = checkTokens({ '--fx-text': '#000000', '--fx-bg': '#ffffff' });
  assert.deepEqual(ok, []);
  const bad = checkTokens({ '--fx-text': '#aaaaaa', '--fx-bg': '#ffffff', '--fx-text-muted': '#bbbbbb' });
  assert.equal(bad.length, 2);
  assert.ok(bad.every((f) => f.severity === 'warning' && f.rule === 'contrast-token'));
  assert.ok(TOKEN_PAIRS.length > 5);
});

test('parseTokensCss reads light defaults and dark overrides', () => {
  const css = ":root { --fx-bg: #ffffff; --fx-text: #111111; }\n:root[data-theme='dark'] { --fx-bg: #000000; }";
  const { light, dark } = parseTokensCss(css);
  assert.equal(light['--fx-bg'], '#ffffff');
  assert.equal(dark['--fx-bg'], '#000000');
  assert.equal(dark['--fx-text'], '#111111');
});

test('shipped tokens.css text pairs are checked in light and dark, reported as warnings only', (t) => {
  const css = fs.readFileSync(fileURLToPath(new URL('../../../../src/web/shared/tokens.css', import.meta.url)), 'utf8');
  const { light, dark } = parseTokensCss(css);
  const findings = [...checkTokens(light, { scope: 'light' }), ...checkTokens(dark, { scope: 'dark' })];
  reportWarnings(findings, { label: 'tokens.css', diagnostic: (m) => t.diagnostic(m) });
  assert.ok(Object.keys(light).length > 10);
});

test('checkBranding flags brand colours no text colour can sit on', () => {
  assert.deepEqual(checkBranding({ primaryColor: '#1f5f4a', accentColor: '#243b6b' }), []);
  assert.equal(checkBranding({ primaryColor: '#777777' }).length, 1);
  assert.deepEqual(checkBranding({}), []);
});

test('checkDocument reports missing labels, alt, landmarks and lang', () => {
  const bad = doc(
    el('input', { id: 'a', type: 'text' }),
    el('img', { id: 'logo' }),
    el('button', {}, [], ''),
  );
  delete bad.attrs.lang;
  const rules = checkDocument(bad).map((f) => f.rule);
  for (const r of ['label', 'alt', 'name', 'landmark', 'heading', 'lang']) assert.ok(rules.includes(r), r);
});

test('checkDocument is quiet on a well-formed page', () => {
  const good = doc(
    el('header', {}, [el('img', { alt: '' })]),
    el('main', {}, [
      el('h1', {}, [], 'Title'),
      el('label', { for: 'n' }, [], 'Name'), el('input', { id: 'n', type: 'text' }),
      el('label', {}, [el('input', { type: 'checkbox' })], 'Agree'),
      el('input', { type: 'hidden' }), el('input', { type: 'text', 'aria-label': 'Search' }),
      el('button', {}, [], 'Go'),
    ]),
  );
  assert.deepEqual(checkDocument(good), []);
});

test('checkDocument flags duplicate ids', () => {
  const page = doc(el('header', {}), el('main', {}, [el('h1', {}, [], 'T'), el('p', { id: 'x' }), el('p', { id: 'x' })]));
  assert.ok(checkDocument(page).some((f) => f.rule === 'duplicate-id'));
});

test('reportWarnings never throws and routes to the sinks', () => {
  const seen = [];
  const lines = reportWarnings([{ rule: 'alt', target: 'img', message: 'x' }], { diagnostic: (m) => seen.push(m), warn: () => { throw new Error('boom'); } });
  assert.equal(lines.length, 1);
  assert.equal(seen.length, 1);
  assert.match(reportWarnings([], { diagnostic: (m) => seen.push(m) })[0], /no accessibility warnings/);
});

test('checkDocument source is self-contained so page.evaluate can ship it', () => {
  const fn = new Function(`return (${checkDocument.toString()})`)();
  assert.equal(typeof fn, 'function');
  assert.ok(Array.isArray(fn(doc(el('main', {})))));
});
