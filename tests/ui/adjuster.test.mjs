// Playwright smoke for /adjuster. Skips cleanly when Playwright or chromium is unavailable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, bootApp, apiClient, createSeededClaim } from './adjuster-harness.mjs';

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

async function signIn(page) {
  await page.goto(`${server.app.url}/adjuster`);
  await page.waitForSelector('#dev-form');
  await page.click('#dev-go');
  await page.waitForSelector('#inbox-sec:not([hidden])');
}

test('adjuster signs in, sees the inbox and the claim summary with every panel', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    await signIn(page);

    // The claim is routed to another adjuster, so it only appears with "only my claims" off.
    await page.uncheck('#inbox-mine');
    const row = page.locator(`tr[data-claim-id="${claim.id}"]`);
    await row.waitFor();
    assert.ok(await row.locator('[data-chip="severity"]').count() > 0, 'severity chip');
    assert.ok(await row.locator('[data-chip="flag"]').count() > 0, 'flag chip');
    assert.ok(await row.locator('[data-chip="timer"]').count() > 0, 'timer chip');

    await row.locator('a').click();
    await page.waitForSelector('#summary-text');
    assert.ok((await page.textContent('#summary-text')).trim().length > 0, 'summary has text');
    for (const id of ['summary', 'nba', 'triage', 'coverage', 'routing', 'timers', 'documents', 'tasks', 'notes', 'timeline']) {
      assert.equal(await page.locator(`#panel-${id}`).count(), 1, `panel ${id}`);
    }

    // AI explain shows provenance.
    await page.click('#panel-summary summary');
    const explain = await page.textContent('#panel-summary .explain');
    assert.match(explain, /Provider/);
    assert.match(explain, /Confidence \d+%/);

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
