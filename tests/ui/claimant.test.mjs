// Playwright smoke for /claimant (Aurelia guided glass-style intake, Spanish, Kestrel branding).
// Skips cleanly when Playwright or chromium is unavailable. a11y findings are warnings only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, bootApp, answerClaimantQuestion, reportPageA11y, CLAIM_NUMBER } from './a11y-harness.mjs';

let server; let browser; let skip;

before(async () => {
  const launched = await launchBrowser();
  if (launched.skip) { skip = launched.skip; return; }
  browser = launched.browser;
  server = await bootApp();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function open(path = '/claimant') {
  const page = await browser.newPage();
  page.pageErrors = [];
  page.on('pageerror', (e) => page.pageErrors.push(e.message));
  await page.goto(`${server.app.url}${path}`);
  await page.waitForSelector('input[name="lob"]');
  return page;
}

/** Walk the guided flow with synthetic answers until the review step. Returns the questions seen. */
async function completeGuided(page, t) {
  const asked = [];
  await page.check('input[name="lob"][value="personal_auto"]');
  await page.check('input[name="mode"][value="guided"]');
  await page.click('form button[type="submit"]');
  for (let i = 0; i < 25; i += 1) {
    await page.waitForSelector('#review-title, main form');
    if (await page.locator('#review-title').count()) return asked;
    const q = await answerClaimantQuestion(page);
    asked.push(q);
    await page.waitForFunction((prev) => {
      const m = document.querySelector('main');
      const label = (m.querySelector('legend, form label') ?? {}).textContent?.trim();
      return document.querySelector('#review-title') || label !== prev;
    }, q, { timeout: 5000 });
  }
  throw new Error(`guided flow did not reach review; asked: ${asked.join(' | ')}`);
}

test('claimant (Aurelia) completes guided intake to a claim number and status page', async (t) => {
  if (skip) return t.skip(skip);
  const page = await open('/claimant?tenant=aurelia-mutual');
  try {
    assert.equal((await page.textContent('#brand-name')).trim(), 'Aurelia Mutual (fictional)');
    const a11yStart = await reportPageA11y(page, 'claimant start', t);

    const asked = await completeGuided(page, t);
    assert.ok(asked.length >= 4, `answered ${asked.length} questions`);
    await page.click('#review-title ~ button');
    await page.waitForSelector('#claim-number');

    const number = (await page.textContent('#claim-number')).trim();
    assert.match(number, CLAIM_NUMBER, 'claim number format');
    assert.match(number, /^AUR-/, 'Aurelia claim number prefix');

    // Status page: stage list with exactly one current step.
    await page.waitForSelector('#status-box ol.timeline li');
    assert.ok(await page.locator('#status-box ol.timeline li').count() >= 4, 'timeline stages');
    assert.equal(await page.locator('#status-box li[aria-current="step"]').count(), 1, 'one current stage');
    assert.ok(await page.locator('#ev-files').count() === 1, 'evidence upload is offered');

    const a11yStatus = await reportPageA11y(page, 'claimant status', t);
    t.diagnostic(`a11y warnings: start=${a11yStart.findings.length} status=${a11yStatus.findings.length}`);
  } finally {
    await page.close();
  }
});

test('claimant UI raises no browser errors after submit (status poller)', { todo: 'blocker S2-EXP-03-1: status.js timers.setTimeout Illegal invocation' }, async (t) => {
  if (skip) return t.skip(skip);
  const page = await open();
  try {
    await completeGuided(page, t);
    await page.click('#review-title ~ button');
    await page.waitForSelector('#claim-number');
    await page.waitForTimeout(500);
    // BUG S2-EXP-03-1: src/web/claimant/status.js calls timers.setTimeout(...) on a plain object holding the
    // window's setTimeout, which throws "Illegal invocation" in browsers, so status polling never schedules.
    assert.deepEqual(page.pageErrors, [], 'claimant status poller threw in the browser (status.js timers.setTimeout, see blocker)');
  } finally {
    await page.close();
  }
});

test('claimant can reach the personal auto glass question set (loss type)', { todo: 'blocker S2-EXP-03-2: claimant app sends no lossType' }, async (t) => {
  if (skip) return t.skip(skip);
  const page = await open();
  try {
    const asked = await completeGuided(page, t);
    // BUG S2-EXP-03-2: app.js never sends lossType, so config.getQuestionSet always picks auto-general and the
    // tenant's auto-glass set (glass_location question) cannot be reached from the claimant UI.
    const glass = asked.some((q) => /glass|windshield|window/i.test(q ?? '') && /where|which|location|part/i.test(q ?? ''));
    assert.ok(glass, `no glass location question was asked; got: ${asked.join(' | ')} (claimant app does not send lossType, see blocker)`);
  } finally {
    await page.close();
  }
});

test('Spanish toggle switches labels on Aurelia', async (t) => {
  if (skip) return t.skip(skip);
  const page = await open('/claimant?tenant=aurelia-mutual');
  try {
    await page.waitForSelector('#lang-wrap:not([hidden])');
    assert.equal((await page.textContent('h1')).trim(), 'Tell us what happened');
    await page.selectOption('#lang-picker', 'es');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent.trim() === 'Cuéntenos qué pasó');
    assert.equal(await page.getAttribute('html', 'lang'), 'es');
    assert.equal((await page.textContent('#lang-label')).trim(), 'Idioma');
    assert.equal((await page.textContent('form button[type="submit"]')).trim(), 'Comenzar');
    await reportPageA11y(page, 'claimant start (es)', t);
  } finally {
    await page.close();
  }
});

test('English-only tenant (Kestrel) does not show the language picker', { todo: 'blocker S2-EXP-03-3: .ctl display:flex overrides [hidden]' }, async (t) => {
  if (skip) return t.skip(skip);
  const page = await open('/claimant?tenant=kestrel-point');
  try {
    // BUG S2-EXP-03-3: app.css `.ctl { display: flex }` overrides the [hidden] attribute on #lang-wrap, so an
    // empty language picker stays visible for tenants that only offer English.
    assert.equal(await page.locator('#lang-wrap').isVisible(), false, 'empty language picker is visible for Kestrel (app.css .ctl overrides [hidden], see blocker)');
  } finally {
    await page.close();
  }
});

test('Kestrel branding differs from Aurelia (name and brand colour token)', async (t) => {
  if (skip) return t.skip(skip);
  const brand = async (tenant) => {
    const page = await browser.newPage();
    try {
      await page.goto(`${server.app.url}/claimant?tenant=${tenant}`);
      await page.waitForSelector('input[name="lob"]');
      return await page.evaluate(() => ({
        name: document.getElementById('brand-name').textContent.trim(),
        brand: getComputedStyle(document.documentElement).getPropertyValue('--fx-brand').trim().toLowerCase(),
        picker: document.getElementById('tenant-picker').value,
      }));
    } finally {
      await page.close();
    }
  };
  const aurelia = await brand('aurelia-mutual');
  const kestrel = await brand('kestrel-point');
  assert.equal(aurelia.name, 'Aurelia Mutual (fictional)');
  assert.equal(kestrel.name, 'Kestrel Point Insurance (fictional)');
  assert.equal(aurelia.brand, '#1f5f4a');
  assert.equal(kestrel.brand, '#243b6b');
  assert.notEqual(aurelia.brand, kestrel.brand);
  assert.equal(kestrel.picker, 'kestrel-point');
});
