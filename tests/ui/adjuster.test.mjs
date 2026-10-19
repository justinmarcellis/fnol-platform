// Playwright smoke for /adjuster. Skips cleanly when Playwright or chromium is unavailable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, bootApp, apiClient, createSeededClaim, sampleClaim } from './adjuster-harness.mjs';

let server; let browser; let skip; let claim; let api;

before(async () => {
  const launched = await launchBrowser();
  if (launched.skip) { skip = launched.skip; return; }
  browser = launched.browser;
  server = await bootApp();
  api = apiClient(server.app);
  claim = await createSeededClaim(api);
});
after(async () => {
  await browser?.close();
  await server?.close();
});

/** Sign in through the demo bar, the way a demo user does. */
async function signIn(page, persona = 'aurelia-mutual:adjuster') {
  await page.goto(`${server.app.url}/adjuster`);
  await page.waitForSelector(`fx-demo-bar #fxd-persona option[value="${persona}"]`, { state: 'attached' });
  await page.selectOption('#fxd-persona', persona);
  await page.waitForSelector('#inbox-sec:not([hidden])');
}

test('signed out with the demo bar: persona prompt, no legacy dev form', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    await page.goto(`${server.app.url}/adjuster`);
    await page.waitForSelector('fx-demo-bar .fxd');
    await page.waitForSelector('#signin-empty');
    assert.equal(await page.locator('#dev-form').count(), 0, 'old dev form is gone');
    assert.equal(await page.locator('fx-app-shell').count(), 1);
    assert.match(await page.textContent('#signin-empty'), /Choose a persona/);
  } finally { await page.close(); }
});

test('inbox empty state offers the whole queue', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    await signIn(page, 'aurelia-mutual:supervisor'); // owns no claims
    await page.waitForSelector('#inbox-empty');
    assert.match(await page.textContent('#inbox-empty'), /inbox is clear/);
    await page.click('#inbox-empty button');
    await page.waitForSelector('fx-table');
  } finally { await page.close(); }
});

test('inbox: KPI tiles, filters, sorting; then the claim first view', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    await signIn(page);
    await page.waitForSelector('fx-table');
    assert.equal(await page.locator('#kpis fx-stat').count(), 4);

    await page.selectOption('#inbox-scope', 'all');
    const link = page.locator(`a[data-claim-id="${claim.id}"]`);
    await link.waitFor();
    const row = page.locator('fx-table tbody tr', { has: link });
    for (const chip of ['severity', 'status', 'timer']) assert.ok(await row.locator(`[data-chip="${chip}"]`).count() > 0, `${chip} chip`);
    assert.ok(await page.locator('#kpis fx-stat[data-kpi="open"] .fx-stat-value').textContent() >= '1');
    // Insured name loads after the table (claim created with an insured party).
    const withParty = await api('POST', '/claims', { role: 'csr', body: { ...sampleClaim(), parties: [{ roles: ['insured'], kind: 'person', firstName: 'Avery', lastName: 'Teststone' }] } });
    assert.equal(withParty.status, 201, JSON.stringify(withParty.json));
    await page.click('#inbox-refresh');
    await page.waitForSelector(`a[data-claim-id="${withParty.json.id}"]`);
    await page.waitForSelector('fx-table td:has-text("Avery Teststone")');

    // Filters: a severity band nobody has leaves a no-match state, clearing restores the row.
    await page.selectOption('#inbox-severity', 'severe');
    const sev = await row.locator('[data-chip="severity"]').count().catch(() => 0);
    if (!sev) {
      await page.waitForSelector('#inbox-empty');
      await page.click('#filters-clear');
      await link.waitFor();
    }
    await page.selectOption('#inbox-severity', 'all');

    // Sorting: header buttons set aria-sort.
    await page.click('fx-table th:nth-child(1) button');
    assert.equal(await page.getAttribute('fx-table th:nth-child(1)', 'aria-sort'), 'ascending');

    await page.locator(`a[data-claim-id="${claim.id}"]`).click();
    await page.waitForSelector('#summary-text');
    assert.ok((await page.textContent('#summary-text')).trim().length > 0, 'summary has text');
    for (const id of ['header', 'summary', 'nba', 'triage', 'coverage', 'routing', 'timers', 'parties', 'vehicles', 'documents', 'tasks', 'notes', 'timeline']) {
      assert.equal(await page.locator(`#panel-${id}`).count(), 1, `panel ${id}`);
    }
    assert.match(await page.textContent('fx-app-shell .fx-shell-title'), /Claim /);

    // AI provenance is visible without any click.
    const ai = await page.textContent('#summary-ai');
    assert.match(ai, /Provider/);
    assert.match(ai, /Model/);
    assert.match(ai, /Confidence/);
    assert.match(ai, /Explanation/);

    // Checklist ticks update progress.
    const boxes = page.locator('#panel-nba input[data-code]');
    if (await boxes.count()) {
      await boxes.first().check();
      assert.match(await page.textContent('#nba-progress'), /^1 of \d+ done/);
    }

    // Add a note round trip.
    await page.fill('#note-new', 'Called the insured, synthetic.');
    await page.click('.note-form button');
    await page.waitForSelector('#panel-notes li:has-text("Called the insured")');
  } finally { await page.close(); }
});

test('fraud item: note is required, accept records a decision', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    // Inject a fraud and subrogation signal into the otherwise real view response.
    await page.route('**/api/v1/adjuster/claims/*/view', async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      json.triage.fraud = { score: 80, referToSiu: true, indicators: [{ code: 'late_report', reason: 'Reported late (synthetic)' }] };
      json.triage.subrogation = { flag: true, reasons: [{ code: 'rear_ended_by_other', reason: 'Other driver at fault (synthetic)' }] };
      await route.fulfill({ response: res, json });
    });
    await signIn(page);
    await page.goto(`${server.app.url}/adjuster#/claim/${claim.id}`);
    await page.waitForSelector('#subro-banner');
    await page.waitForSelector('form.decision[data-kind="fraud"]');

    // Empty note is refused client side.
    await page.click('form.decision[data-kind="fraud"] button[data-action="accepted"]');
    assert.match(await page.textContent('form.decision[data-kind="fraud"] .err'), /Add a note/);

    await page.fill('#note-fraud', 'Confirmed with SIU lead.');
    await page.click('form.decision[data-kind="fraud"] button[data-action="accepted"]');
    await page.waitForSelector('#item-fraud [data-decision="accepted"]');
    assert.match(await page.textContent('#item-fraud'), /Confirmed with SIU lead/);

    // Subrogation dismiss with a note.
    await page.fill('#note-subrogation', 'No recoverable party.');
    await page.click('form.decision[data-kind="subrogation"] button[data-action="dismissed"]');
    await page.waitForSelector('#item-subrogation [data-decision="dismissed"]');

    // The decision is stored as a categorised note through the API.
    const notes = await api('GET', `/claims/${claim.id}/notes`, { role: 'adjuster' });
    assert.ok(notes.json.items.some((n) => n.category === 'fraud' && n.body.startsWith('[decision:accepted]')));
    assert.ok(notes.json.items.some((n) => n.category === 'subrogation' && n.body.startsWith('[decision:dismissed]')));
  } finally { await page.close(); }
});

test('unknown claim shows not found', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    await signIn(page);
    await page.goto(`${server.app.url}/adjuster#/claim/clm_doesnotexist`);
    await page.waitForSelector('#claim-body:has-text("not found")');
  } finally { await page.close(); }
});
