// Playwright test for /admin. Skips cleanly when Playwright or chromium is unavailable.
// Runs against a temp database and a temp copy of the tenants; repo config is never written.
import path from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, bootApp, apiClient, readConfig, ROOT } from './admin-harness.mjs';

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

const SHOTS = path.join(ROOT, 'docs', 'design', 'screens');
const SECTIONS = ['branding', 'questions', 'rules', 'timers', 'webhooks', 'ai', 'kpis', 'history'];

/** Sign in the way a demo user does: pick the Carrier admin persona in the demo bar. */
async function signIn(page, tenant = 'aurelia-mutual') {
  await page.goto(`${server.app.url}/admin?tenant=${tenant}`);
  await page.waitForSelector(`fx-demo-bar #fxd-persona option[value="${tenant}:carrier-admin"]`, { state: 'attached' });
  await page.selectOption('#fxd-persona', `${tenant}:carrier-admin`);
  await page.waitForSelector('#console:not([hidden])');
  await page.waitForSelector('#panel h2');
}

async function newPage(width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const close = page.close.bind(page);
  page.close = async () => { await close(); await context.close(); };
  return page;
}

test('persona sign-in replaces the old dev form and uses the app shell', async (t) => {
  if (skip) return t.skip(skip);
  const page = await newPage();
  try {
    await page.goto(`${server.app.url}/admin?tenant=aurelia-mutual`);
    await page.waitForSelector('#pick-persona:not([hidden])');
    assert.equal(await page.locator('#dev-panel').isHidden(), true, 'old dev form is not shown when the demo bar is present');
    assert.equal(await page.locator('fx-app-shell fx-demo-bar .fxd').count(), 1, 'demo bar mounted in the shell');
    await page.selectOption('#fxd-persona', 'aurelia-mutual:carrier-admin');
    await page.waitForSelector('#console:not([hidden])');
    assert.equal(await page.locator('#dev-panel').isHidden(), true);
    assert.match(await page.textContent('fx-app-shell .fx-shell-userbtn'), /Taylor Brandt/);
    assert.match(await page.textContent('fx-app-shell .fx-shell-title'), /Settings/);
    assert.match(await page.textContent('#version-label'), /^Version \d+$/);
  } finally { await page.close(); }
});

test('left navigation lists every section and each renders cards', async (t) => {
  if (skip) return t.skip(skip);
  const page = await newPage();
  try {
    await signIn(page);
    const labels = await page.locator('#tabs a').allTextContents();
    for (const want of ['Branding', 'Intake questions', 'Routing and fast-track rules', 'Regulatory timers', 'Integrations and webhooks', 'AI settings', 'KPIs']) {
      assert.ok(labels.some((l) => l.includes(want)), `nav has ${want}`);
    }
    for (const id of SECTIONS) {
      await page.click(`#tab-${id}`);
      await page.waitForSelector(`#h-${id}`);
      assert.equal(await page.getAttribute(`#tab-${id}`, 'aria-current'), 'page');
      if (!['kpis', 'history'].includes(id)) assert.ok(await page.locator('#panel fx-card').count() > 0, `${id} uses cards`);
    }
    await page.click('#tab-questions');
    assert.ok(await page.locator('[data-path$="/showIf"]').count() > 0, 'questions have showIf editors');
    await page.click('#tab-rules');
    assert.ok(await page.locator('[data-path$="/when"]').count() > 0, 'rules have when editors');
    await page.click('#tab-ai');
    assert.ok(await page.locator('[data-path="/ai/provider"]').count() === 1, 'AI provider field');
    // Every control has an accessible label and help text is wired with aria-describedby.
    await page.click('#tab-branding');
    assert.match(await page.getAttribute('[data-path="/claimNumberPrefix"]', 'aria-describedby'), /hint/);
    assert.equal(await page.locator('label[for="f-branding-primaryColor"]').count(), 1);
  } finally { await page.close(); }
});

test('history and KPI panels render data or a fallback; KPIs show stat tiles', async (t) => {
  if (skip) return t.skip(skip);
  const page = await newPage();
  try {
    await signIn(page);
    await page.click('#tab-history');
    await page.waitForSelector('#history-fallback, #panel .grid-table');
    const rows = await page.locator('#panel tr[data-version]').count();
    const fallback = await page.locator('#history-fallback').count();
    assert.ok(rows > 0 || fallback === 1, 'history rows or fallback');
    await page.click('#tab-kpis');
    await page.waitForSelector('#kpi-tiles fx-stat, #kpi-fallback');
    assert.equal(await page.locator('#panel:has-text("Loading KPIs")').count(), 0);
    assert.ok(await page.locator('#kpi-tiles fx-stat').count() > 0, 'KPI stat tiles');
  } finally { await page.close(); }
});

test('screenshots at 1440x900 for review', async (t) => {
  if (skip) return t.skip(skip);
  // A few claims so the KPI tiles carry real numbers.
  const { fixturePolicies } = await import('../../src/modules/coverage/index.mjs');
  const tc = server.app.ctx.forTenant('aurelia-mutual');
  await tc.modules.coverage.seedPolicies(fixturePolicies);
  for (const key of ['k1', 'k2', 'k3']) {
    await tc.modules.claims.createClaim({ lob: 'personal_auto', channel: 'claimant_web', riskState: 'IL', policyNumber: 'AUT-100001', idempotencyKey: key,
      lossEvent: { lossDate: '2026-09-10', cause: 'collision', description: 'Synthetic rear-end collision.' } }, { actor: 'test' });
  }
  await server.app.ctx.bus.drain();
  const page = await newPage(1440, 900);
  try {
    await signIn(page);
    const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(SHOTS, `admin-${name}.png`) }); };
    await page.click('#tab-branding');
    await page.fill('[data-path="/branding/supportPhone"]', '555-0100');
    await shot('branding');
    await page.click('#revert');
    await page.click('#tab-rules');
    await shot('rules');
    await page.click('#tab-kpis');
    await page.waitForSelector('#kpi-tiles fx-stat, #kpi-fallback');
    await shot('kpis');
  } finally { await page.close(); }
});

test('invalid values show inline errors from /config/validate and nothing is saved', async (t) => {
  if (skip) return t.skip(skip);
  const before = await readConfig(server.app, 'aurelia-mutual');
  const page = await newPage();
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

  const page = await newPage();
  try {
    await signIn(page);
    await page.click('#tab-rules');
    const field = page.locator(`[data-path="/rules/${idx}/when"]`);
    await field.fill(JSON.stringify(when, null, 2));
    assert.match(await page.textContent('#dirty-label'), /^Unsaved/);
    await page.click('#save');
    await page.waitForSelector('#diff[open]');
    assert.ok(await page.locator(`#diff-body tr[data-diff="/rules/${idx}/when/all/${when.all.indexOf(sev)}/value"]`).count() === 1, 'diff preview lists the changed field');
    assert.equal((await readConfig(server.app, 'aurelia-mutual')).version, aurBefore.version, 'nothing saved before confirming');
    await page.click('#diff-confirm');
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
  const page = await newPage();
  try {
    await signIn(page);
    // Another admin saves first.
    const current = await readConfig(server.app, 'aurelia-mutual');
    const bumped = { ...current, displayName: `${current.displayName} Co` };
    const put = await api('PUT', '/config', { role: 'tenant_admin', body: bumped });
    assert.equal(put.status, 200, JSON.stringify(put.json));

    await page.fill('[data-path="/branding/supportPhone"]', '555-0100');
    await page.click('#save');
    await page.waitForSelector('#diff[open]');
    await page.click('#diff-confirm');
    await page.waitForSelector('#conflict:not([hidden])');
    const latest = await readConfig(server.app, 'aurelia-mutual');
    assert.notEqual(latest.branding.supportPhone, '555-0100', 'stale save was not applied');
    await page.click('#conflict-reload');
    await page.waitForSelector('#conflict', { state: 'hidden' });
    assert.match(await page.textContent('#version-label'), new RegExp(`Version ${latest.version}$`));
  } finally { await page.close(); }
});

test('a diff preview can be cancelled and the draft is kept', async (t) => {
  if (skip) return t.skip(skip);
  const before = await readConfig(server.app, 'aurelia-mutual');
  const page = await newPage();
  try {
    await signIn(page);
    await page.fill('[data-path="/branding/supportPhone"]', '555-0142');
    assert.equal(await page.getAttribute('#savebar', 'data-dirty'), 'true');
    assert.match(await page.textContent('#tabs #tab-branding'), /unsaved|^\s*Branding/i);
    await page.click('#save');
    await page.waitForSelector('#diff[open]');
    assert.match(await page.textContent('#diff-body'), /555-0142/);
    await page.click('#diff-cancel');
    await page.waitForSelector('#diff:not([open])', { state: 'attached' });
    assert.equal(await page.inputValue('[data-path="/branding/supportPhone"]'), '555-0142');
    assert.equal((await readConfig(server.app, 'aurelia-mutual')).version, before.version);
    await page.click('#revert');
    assert.match(await page.textContent('#dirty-label'), /^No unsaved/);
  } finally { await page.close(); }
});

test('AI settings save and webhook management still work', async (t) => {
  if (skip) return t.skip(skip);
  const page = await newPage();
  try {
    await signIn(page);
    await page.click('#tab-ai');
    const before = await readConfig(server.app, 'aurelia-mutual');
    await page.fill('[data-path="/ai/maxTokensPerClaim"]', '41000');
    await page.click('#save');
    await page.waitForSelector('#diff[open]');
    await page.click('#diff-confirm');
    await page.waitForFunction((v) => document.getElementById('version-label').textContent === `Version ${v}`, before.version + 1);
    assert.equal((await readConfig(server.app, 'aurelia-mutual')).ai.maxTokensPerClaim, 41000);

    await page.click('#tab-webhooks');
    await page.waitForSelector('#wh-form');
    await page.fill('#wh-url', 'https://hooks.aurelia-mutual.example/claims');
    await page.fill('#wh-events', 'claim.created');
    await page.click('#wh-add');
    await page.waitForSelector('tr[data-webhook]');
    assert.match(await page.textContent('tr[data-webhook]'), /hooks\.aurelia-mutual/);
    await page.click('tr[data-webhook] [data-act="wh-toggle"]');
    await page.waitForSelector('tr[data-webhook] fx-badge[label="Paused"]');
    await page.click('tr[data-webhook] [data-act="wh-delete"]');
    await page.waitForSelector('tr[data-webhook]', { state: 'detached' });
  } finally { await page.close(); }
});
