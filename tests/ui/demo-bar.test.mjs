// Playwright smoke for <fx-demo-bar>. Skips cleanly when Playwright or chromium is unavailable.
// The bar is injected into the real apps by an init script (Wave B wires it into each app).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOT = path.join(ROOT, 'docs', 'design', 'screens', 'demo-bar.png');
const INJECT = `document.addEventListener('DOMContentLoaded', async () => {
  await import('/shared/components/demo-bar.js');
  if (!document.querySelector('fx-demo-bar')) document.body.prepend(document.createElement('fx-demo-bar'));
});`;

let browser; let skip; const servers = []; const dirs = [];

async function launch() {
  const require = createRequire(import.meta.url);
  let pw = null;
  for (const c of ['playwright', '/opt/node-tools/node_modules/playwright', path.join(os.homedir(), '.npm-global/lib/node_modules/playwright')]) {
    try { pw = require(c); break; } catch { /* next */ }
  }
  if (!pw?.chromium) return { skip: 'playwright is not installed' };
  try { return { browser: await pw.chromium.launch({ headless: true }) }; } catch (e) { return { skip: `chromium could not launch: ${String(e.message).split('\n')[0]}` }; }
}

async function boot(devMode, seed) {
  const { createApp } = await import('../../src/server.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-demobar-'));
  dirs.push(dir);
  const app = await createApp({ dbPath: path.join(dir, 'ui.db'), port: 0, secretsDir: path.join(dir, 's'), tenantsDir: path.join(ROOT, 'tenants'), logLevel: 'silent', devMode });
  servers.push(app);
  if (seed) {
    const { fixturePolicies } = await import('../../src/modules/coverage/index.mjs');
    const t = app.ctx.forTenant('aurelia-mutual');
    await t.modules.coverage.seedPolicies(fixturePolicies);
    const ids = [];
    for (const key of ['d1', 'd2']) {
      const c = await t.modules.claims.createClaim({ lob: 'personal_auto', channel: 'csr_phone', riskState: 'IL', policyNumber: 'AUT-100001', idempotencyKey: key,
        lossEvent: { lossDate: '2026-09-10', cause: 'collision', description: 'Synthetic rear-end collision.' } }, { actor: 'test' });
      ids.push(c.id);
    }
    await app.ctx.bus.drain();
    for (const id of ids) {
      t.db.run("UPDATE claims SET adjuster_id = 'adj-demo-1', status = 'in_review' WHERE id = ?", id);
      t.db.run("UPDATE adjuster_inbox SET adjuster_id = 'adj-demo-1', status = 'in_review' WHERE claim_id = ?", id);
    }
  }
  return app;
}

before(async () => {
  const l = await launch();
  if (l.skip) { skip = l.skip; return; }
  browser = l.browser;
});
after(async () => {
  await browser?.close();
  for (const s of servers) await s.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

async function newPage(width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript(INJECT);
  return page;
}

test('switching claimant to adjuster lands signed in on the adjuster inbox', async (t) => {
  if (skip) return t.skip(skip);
  const app = await boot(true, true);
  const page = await newPage();
  await page.goto(`${app.url}/?tenant=aurelia-mutual`);
  await page.waitForSelector('fx-demo-bar #fxd-persona option[value="aurelia-mutual:adjuster"]', { state: 'attached' });
  await page.selectOption('#fxd-persona', 'aurelia-mutual:adjuster');
  await page.waitForURL('**/adjuster');
  await page.waitForSelector('#inbox-sec:not([hidden])');
  assert.equal(await page.locator('#dev-panel').isHidden(), true, 'old dev form is not shown');
  await page.waitForSelector('#inbox-body tr[data-claim-id]');
  assert.ok(await page.locator('#inbox-body tr[data-claim-id]').count() >= 1, 'inbox has claims');
  assert.match(await page.textContent('fx-demo-bar .fxd-name'), /Jordan/);
  assert.match(await page.textContent('fx-demo-bar .fxd-role'), /Adjuster/);
  // Identity is shown once: the shell account menu carries the persona, the demo bar block is hidden.
  assert.equal(await page.locator('fx-demo-bar .fxd-who').first().isHidden(), true, 'demo bar does not repeat the persona');
  assert.match(await page.textContent('fx-app-shell .fx-shell-username'), /Jordan/);
  // Fonts: brand font only on the mark and tenant name; page title, demo bar and selects use the product UI font.
  const ff = (sel) => page.locator(sel).first().evaluate((n) => getComputedStyle(n).fontFamily.replace(/"/g, "'").replace(/'Inter'/, 'Inter'));
  const ui = (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fx-font-ui').trim())).replace(/"/g, "'");
  assert.match(await ff('fx-app-shell .fx-shell-tenant'), /Georgia/, 'tenant name keeps the brand font');
  for (const sel of ['fx-app-shell .fx-shell-title', 'fx-demo-bar', 'fx-demo-bar select']) assert.equal(await ff(sel), ui.replace(/'Inter'/, 'Inter'), `${sel} uses the UI font`);
  assert.doesNotMatch(await ff('fx-demo-bar select'), /Georgia/i);
  await page.screenshot({ path: SHOT });
  await page.context().close();
});

test('switching tenant changes branding', async (t) => {
  if (skip) return t.skip(skip);
  const app = await boot(true, false);
  const page = await newPage();
  await page.goto(`${app.url}/?tenant=aurelia-mutual`);
  await page.waitForSelector('fx-demo-bar #fxd-persona option[value="aurelia-mutual:claimant"]', { state: 'attached' });
  await page.selectOption('#fxd-persona', 'aurelia-mutual:claimant');
  await page.waitForURL('**/?tenant=aurelia-mutual');
  await page.waitForSelector('#fxd-tenant:not([disabled])');
  const brand = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fx-brand').trim().toLowerCase());
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--fx-brand').trim() === '#1f5f4a');
  const before = await brand();
  await page.selectOption('#fxd-tenant', 'kestrel-point');
  await page.waitForURL('**/?tenant=kestrel-point');
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--fx-brand').trim() === '#243b6b');
  assert.notEqual(await brand(), before);
  await page.context().close();
});

test('keyboard: controls are labelled and Escape closes the compact panel', async (t) => {
  if (skip) return t.skip(skip);
  const app = await boot(true, false);
  const page = await newPage(420);
  await page.goto(`${app.url}/csr`);
  await page.waitForSelector('fx-demo-bar .fxd-toggle');
  assert.equal(await page.getAttribute('.fxd-toggle', 'aria-expanded'), 'false');
  await page.focus('.fxd-toggle');
  await page.keyboard.press('Enter');
  assert.equal(await page.getAttribute('.fxd-toggle', 'aria-expanded'), 'true');
  assert.equal(await page.locator('label[for="fxd-tenant"]').count(), 1);
  assert.equal(await page.locator('label[for="fxd-persona"]').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.getAttribute('.fxd-toggle', 'aria-expanded'), 'false');
  await page.context().close();
});

test('the bar renders nothing when devMode is false', async (t) => {
  if (skip) return t.skip(skip);
  const app = await boot(false, false);
  const page = await newPage();
  await page.goto(`${app.url}/`);
  await page.waitForSelector('fx-demo-bar', { state: 'attached' });
  assert.equal(await page.locator('fx-demo-bar .fxd').count(), 0);
  assert.equal(await page.locator('fx-demo-bar').isHidden(), true);
  await page.context().close();
});
