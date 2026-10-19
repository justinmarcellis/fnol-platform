// S6-BUG-05: demo bar persona labels are not cut off (CLAIMANT-20, DATA-16); every app page has an icon (DATA-17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_BAR_CSS } from '../../../../src/web/shared/components/demo-bar.js';
import { ensureFavicon, FAVICON_HREF } from '../../../../src/web/shared/components/app-shell.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test('the persona select is wide enough for "Firstname Lastname (Carrier admin)" labels', () => {
  const rule = DEMO_BAR_CSS.split('\n').find((l) => l.startsWith('fx-demo-bar select {'));
  assert.ok(rule, 'select rule present');
  assert.doesNotMatch(rule, /max-width:\s*300px/);
  const rem = /max-width:\s*([\d.]+)rem/.exec(rule);
  assert.ok(rem && Number(rem[1]) * 16 >= 420, rule);
});

function fakeDoc(existing) {
  const children = existing ? [existing] : [];
  return {
    children,
    head: {
      querySelector: (sel) => (sel === 'link[rel~="icon"]' ? children.find((c) => /\bicon\b/.test(c.rel)) ?? null : null),
      appendChild: (el) => children.push(el),
    },
    createElement: () => ({}),
  };
}

test('ensureFavicon adds the shared icon once and keeps a page icon', () => {
  const doc = fakeDoc();
  ensureFavicon(doc); ensureFavicon(doc);
  assert.equal(doc.children.length, 1);
  assert.equal(doc.children[0].rel, 'icon');
  assert.equal(doc.children[0].href, FAVICON_HREF);
  const own = fakeDoc({ rel: 'shortcut icon', href: '/x.ico' });
  ensureFavicon(own);
  assert.equal(own.children.length, 1);
  ensureFavicon(null);
  assert.ok(fs.existsSync(path.join(ROOT, 'src/web', FAVICON_HREF)), 'icon file is served from src/web');
});
