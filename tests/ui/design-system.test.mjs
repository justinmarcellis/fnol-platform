// Playwright smoke for the design system v2 kitchen sink (S6-EXP-01).
// Boots the real platform, opens /shared/kitchen-sink.html in Chromium, asserts no console errors and
// no cross-origin requests, checks shell behaviour (demo slot, user menu, responsive nav, focus) and writes
// reviewer screenshots to docs/design/screens/. Skips cleanly when Playwright or Chromium is unavailable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENS = path.join(ROOT, 'docs', 'design', 'screens');
const PAGE = '/shared/kitchen-sink.html';

let browser; let app; let tmp; let skip;

before(async () => {
  const require = createRequire(import.meta.url);
  let pw = null;
  for (const c of ['playwright', '/opt/node-tools/node_modules/playwright']) {
    try { pw = require(c); break; } catch { /* next */ }
  }
  if (!pw?.chromium) { skip = 'playwright is not installed'; return; }
  try { browser = await pw.chromium.launch({ headless: true }); } catch (err) { skip = `chromium could not launch: ${String(err.message).split('\n')[0]}`; return; }
  const { createApp } = await import('../../src/server.mjs');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-ds-'));
  app = await createApp({ dbPath: path.join(tmp, 'ds.db'), port: 0, secretsDir: path.join(tmp, 'secrets'), tenantsDir: path.join(ROOT, 'tenants'), logLevel: 'silent', devMode: true });
});

after(async () => {
  await browser?.close();
  await app?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** Open the kitchen sink with error and request tracking. */
async function open({ width = 1440, height = 900, colorScheme = 'light', query = '' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const origin = new URL(app.url).origin;
  page.errors = []; page.foreign = [];
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('request', (r) => {
    const u = r.url();
    if (u.startsWith('data:') || u.startsWith('blob:')) return;
    if (new URL(u).origin !== origin) page.foreign.push(u);
  });
  await page.goto(`${app.url}${PAGE}${query}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('fx-table tbody tr fx-badge');
  return { page, context };
}

async function shot(page, name, { fullPage = true } = {}) {
  fs.mkdirSync(SCREENS, { recursive: true });
  await page.evaluate(() => document.fonts?.ready);
  await page.screenshot({ path: path.join(SCREENS, name), fullPage });
}

test('kitchen sink renders with no console errors and no external requests (desktop light)', async (t) => {
  if (skip) return t.skip(skip);
  const { page, context } = await open();
  try {
    assert.deepEqual(page.errors, [], 'console errors');
    assert.deepEqual(page.foreign, [], 'non-same-origin requests');
    // Shell anatomy
    assert.equal((await page.textContent('fx-app-shell .fx-shell-product')).trim(), 'Claims Desk');
    assert.match(await page.textContent('fx-app-shell .fx-shell-tenant'), /fictional/);
    assert.equal((await page.textContent('fx-app-shell h1')).trim(), 'Claims overview');
    assert.equal((await page.textContent('.fx-shell-username')).trim(), 'Dana Whitfield');
    assert.equal((await page.textContent('.fx-shell-userrole')).trim(), 'Adjuster');
    assert.equal(await page.locator('.fx-shell-actions .fx-btn').count(), 2, 'page header actions');
    assert.ok(await page.locator('.fx-shell-nav a').count() >= 4, 'nav links slotted');
    // Demo slot: content moved into the band and --fx-demo-height reflects its height.
    assert.equal(await page.locator('.fx-shell-demo .ks-band').count(), 1);
    const demoH = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fx-demo-height').trim());
    assert.match(demoH, /^[1-9]\d*px$/, `demo height ${demoH}`);
    // Status chips carry human labels.
    const labels = await page.locator('#ks-status-badges fx-badge').allTextContents();
    assert.ok(labels.includes('Pending info') && labels.includes('Fast-tracked'), labels.join(','));
    // Numeric column right-aligned.
    assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('fx-table td.fx-num')).textAlign), /^(right|end)$/);
    // Brand from tenant branding flows to primary buttons.
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('#ks-new')).backgroundColor);
    assert.equal(bg, 'rgb(42, 85, 196)');
    await shot(page, 'kitchen-sink-light.png');
  } finally { await context.close(); }
});

test('visible keyboard focus on interactive elements and keyboard user menu', async (t) => {
  if (skip) return t.skip(skip);
  const { page, context } = await open();
  try {
    // Walk the page with Tab and check every focused element shows an indicator (outline >= 2px or a focus ring).
    const seen = [];
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press('Tab');
      const f = await page.evaluate(async () => {
        // Two frames: reduced motion still runs a 0.01ms transition on every property.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''}${el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''}`;
        return { name, style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), shadow: cs.boxShadow, fv: el.matches(':focus-visible') };
      });
      if (!f) continue;
      seen.push(f.name);
      assert.ok((f.style !== 'none' && f.width >= 2) || (f.shadow && f.shadow !== 'none'), `focus visible on ${f.name}: ${JSON.stringify(f)}`);
    }
    for (const want of ['a.fx-shell-brand', 'button.fx-shell-userbtn', 'select#ks-brand', 'tr', 'input', 'span[radio]']) {
      assert.ok(seen.some((n) => n.startsWith(want.split('[')[0]) && (!want.includes('[') || n.includes(want.slice(want.indexOf('['))))), `tabbed to ${want}; saw ${seen.join(' ')}`);
    }
    // User menu opens from the keyboard, Escape closes and returns focus.
    await page.focus('.fx-shell-userbtn');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.fx-shell-menu:not([hidden])');
    assert.equal(await page.getAttribute('.fx-shell-userbtn', 'aria-expanded'), 'true');
    assert.match(await page.textContent('.fx-shell-menu'), /Sign out/);
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'menuitem');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.fx-shell-menu').isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('fx-shell-userbtn')), true);
    assert.deepEqual(page.errors, []);
  } finally { await context.close(); }
});

test('dark theme (system preference) at desktop width', async (t) => {
  if (skip) return t.skip(skip);
  const { page, context } = await open({ colorScheme: 'dark' });
  try {
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, 'rgb(12, 15, 19)', 'dark canvas');
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.foreign, []);
    await shot(page, 'kitchen-sink-dark.png');
  } finally { await context.close(); }
});

test('mobile 390x844: nav collapses behind a menu button, light and dark', async (t) => {
  if (skip) return t.skip(skip);
  for (const scheme of ['light', 'dark']) {
    const { page, context } = await open({ width: 390, height: 844, colorScheme: scheme });
    try {
      assert.equal(await page.locator('.fx-shell-nav').isVisible(), false, 'nav hidden when collapsed');
      assert.equal(await page.locator('.fx-shell-navtoggle').isVisible(), true, 'menu button shown');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `no horizontal page scroll (${overflow}px)`);
      await shot(page, `kitchen-sink-${scheme}-mobile.png`, { fullPage: false }); // phone viewport, as a buyer sees it
      await page.click('.fx-shell-navtoggle');
      assert.equal(await page.locator('.fx-shell-nav').isVisible(), true, 'nav opens');
      assert.equal(await page.getAttribute('.fx-shell-navtoggle', 'aria-expanded'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.fx-shell-nav').isVisible(), false, 'Escape closes nav');
      assert.deepEqual(page.errors, []);
    } finally { await context.close(); }
  }
});

test('tenant brand and Spanish locale switch at runtime', async (t) => {
  if (skip) return t.skip(skip);
  const { page, context } = await open({ query: '?brand=aurelia&lang=es' });
  try {
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#ks-new')).backgroundColor), 'rgb(31, 95, 74)');
    assert.match(await page.textContent('fx-app-shell .fx-shell-tenant'), /Aurelia/);
    const labels = await page.locator('#ks-status-badges fx-badge').allTextContents();
    assert.ok(labels.includes('Información pendiente'), labels.join(','));
    assert.equal((await page.textContent('fx-app-shell h1')).trim(), 'Resumen de siniestros');
    assert.deepEqual(page.errors, []);
  } finally { await context.close(); }
});
