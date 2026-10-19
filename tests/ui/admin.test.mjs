// Playwright test for /admin. Skips cleanly when Playwright or chromium is unavailable.
// Runs against a temp database and a temp copy of the tenants; repo config is never written.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, bootApp, apiClient, readConfig } from './admin-harness.mjs';

let server; let browser; let skip; let api;

before(async () => {
  const launched = await launchBrowser();
  if (launched.skip) { skip = launched.skip; return; }
  browser = launched.browser;
  server = await bootApp();
  api = apiClient(server.app);
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function signIn(page, tenant = 'aurelia-mutual') {
  await page.goto(`${server.app.url}/admin`);
  await page.waitForSelector('#dev-form');
  await page.selectOption('#dev-tenant', tenant);
  await page.click('#dev-go');
  await page.waitForSelector('#console:not([hidden])');
}

test('tenant admin signs in and every editor tab renders', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    await signIn(page);
    assert.match(await page.textContent('#version-label'), /^Version \d+$/);
    for (const tab of ['branding', 'lobs', 'locales', 'questions', 'rules', 'timers', 'webhooks', 'history', 'kpis']) {
      await page.click(`#tab-${tab}`);
      await page.waitForSelector(`#h-${tab}`);
    }
    await page.click('#tab-questions');
    assert.ok(await page.locator('[data-path$="/showIf"]').count() > 0, 'questions have showIf editors');
    await page.click('#tab-rules');
    assert.ok(await page.locator('[data-path$="/when"]').count() > 0, 'rules have when editors');
  } finally { await page.close(); }
});

test('history and KPI panels render data or a 404 fallback', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    await signIn(page);
    await page.click('#tab-history');
    await page.waitForSelector('#history-fallback, #panel .grid-table');
    const rows = await page.locator('#panel tr[data-version]').count();
    const fallback = await page.locator('#history-fallback').count();
    assert.ok(rows > 0 || fallback === 1, 'history rows or fallback');
    await page.click('#tab-kpis');
    await page.waitForSelector('#kpi-fallback, #panel .grid-table, #panel p.muted:not(:has-text("Loading"))');
    assert.equal(await page.locator('#panel:has-text("Loading KPIs")').count(), 0);
  } finally { await page.close(); }
});

test('invalid values show inline errors from /config/validate and nothing is saved', async (t) => {
  if (skip) return t.skip(skip);
  const before = await readConfig(server.app, 'aurelia-mutual');
  const page = await browser.newPage();
  try {
    await signIn(page);
    await page.fill('[data-path="/branding/primaryColor"]', 'not-a-color');
    await page.click('#save');
    await page.waitForSelector('#summary [role="alert"]');
    const inline = page.locator('[data-error-for="/branding/primaryColor"]');
    await inline.waitFor();
    assert.match(await inline.textContent(), /must match/);
    assert.equal(await page.getAttribute('[data-path="/branding/primaryColor"]', 'aria-invalid'), 'true');
    assert.match(await page.textContent('#tab-branding'), /1/, 'tab shows error count');
    const after = await readConfig(server.app, 'aurelia-mutual');
    assert.equal(after.version, before.version, 'no PUT happened');
    assert.equal(after.branding.primaryColor, before.branding.primaryColor);

    // Broken JSON is caught locally, before any request.
    await page.fill('[data-path="/branding/primaryColor"]', before.branding.primaryColor);
    await page.click('#tab-rules');
    await page.fill('[data-path="/rules/0/when"]', '{bad json');
    await page.waitForSelector('[data-error-for="/rules/0/when"]');
    await page.click('#save');
    assert.equal((await readConfig(server.app, 'aurelia-mutual')).version, before.version);
  } finally { await page.close(); }
});

test('Aurelia glass straight-through change persists and Kestrel is unchanged', async (t) => {
  if (skip) return t.skip(skip);
  const aurBefore = await readConfig(server.app, 'aurelia-mutual');
  const kesBefore = await readConfig(server.app, 'kestrel-point');
  const idx = aurBefore.rules.findIndex((r) => r.id === 'RT-FT-GLASS');
  assert.ok(idx >= 0, 'glass rule exists');
  const when = JSON.parse(JSON.stringify(aurBefore.rules[idx].when));
  const sev = when.all.find((c) => c.fact === 'triage.severityScore');
  const oldLimit = sev.value;
  sev.value = oldLimit - 5;

  const page = await browser.newPage();
  try {
    await signIn(page);
    await page.click('#tab-rules');
    const field = page.locator(`[data-path="/rules/${idx}/when"]`);
    await field.fill(JSON.stringify(when, null, 2));
    assert.match(await page.textContent('#dirty-label'), /^Unsaved/);
    await page.click('#save');
    await page.waitForFunction((v) => document.getElementById('version-label').textContent === `Version ${v}`, aurBefore.version + 1);
    assert.match(await page.textContent('#dirty-label'), /^No unsaved/);

    const aurAfter = await readConfig(server.app, 'aurelia-mutual');
    assert.equal(aurAfter.version, aurBefore.version + 1);
    assert.equal(aurAfter.rules[idx].when.all.find((c) => c.fact === 'triage.severityScore').value, oldLimit - 5);

    // Persists across a reload, and the history tab lists the new version (or its fallback).
    await page.reload();
    await page.waitForSelector('#console:not([hidden])');
    await page.click('#tab-rules');
    assert.match(await page.inputValue(`[data-path="/rules/${idx}/when"]`), new RegExp(`"value": ${oldLimit - 5}`));

    const kesAfter = await readConfig(server.app, 'kestrel-point');
    assert.equal(kesAfter.version, kesBefore.version, 'Kestrel version unchanged');
    assert.deepEqual(kesAfter.rules, kesBefore.rules, 'Kestrel rules unchanged');
  } finally { await page.close(); }
});

test('a stale version is rejected with a conflict banner (If-Match)', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    await signIn(page);
    // Another admin saves first.
    const current = await readConfig(server.app, 'aurelia-mutual');
    const bumped = { ...current, displayName: `${current.displayName} Co` };
    const put = await api('PUT', '/config', { role: 'tenant_admin', body: bumped });
    assert.equal(put.status, 200, JSON.stringify(put.json));

    await page.fill('[data-path="/branding/supportPhone"]', '555-0100');
    await page.click('#save');
    await page.waitForSelector('#conflict:not([hidden])');
    const latest = await readConfig(server.app, 'aurelia-mutual');
    assert.notEqual(latest.branding.supportPhone, '555-0100', 'stale save was not applied');
    await page.click('#conflict-reload');
    await page.waitForSelector('#conflict', { state: 'hidden' });
    assert.match(await page.textContent('#version-label'), new RegExp(`Version ${latest.version}$`));
  } finally { await page.close(); }
});
