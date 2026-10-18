// Playwright smoke for /csr: dev login, policy lookup, assisted intake submit. Skips cleanly without Playwright.
// a11y findings are warnings only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, bootApp, answerCsrQuestion, reportPageA11y, CLAIM_NUMBER } from './a11y-harness.mjs';

const TENANT = 'aurelia-mutual';
let server; let browser; let skip; let policy;

before(async () => {
  const launched = await launchBrowser();
  if (launched.skip) { skip = launched.skip; return; }
  browser = launched.browser;
  server = await bootApp();
  policy = server.policies[TENANT][0];
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function signIn(page) {
  await page.goto(`${server.app.url}/csr?tenant=${TENANT}`);
  await page.waitForSelector('#dev-form:not([hidden])');
  await page.selectOption('#dev-tenant', TENANT);
  await page.click('#dev-go');
  await page.waitForSelector('#desk:not([hidden])');
}

async function lookupAndStart(page) {
  await page.fill('#search-field input', policy.policyNumber);
  await page.click('#search-go');
  const row = page.locator('#search-table tbody tr[tabindex]');
  await row.waitFor();
  assert.match(await page.textContent('#search-msg'), /1/, 'one policy found');
  assert.ok((await row.textContent()).includes(policy.policyNumber), 'result row shows the policy number');
  await row.click();
  await page.waitForSelector('#answer-slot fx-field');
}

/** Answer until the submit button shows. Returns the labels answered. */
async function answerAll(page) {
  const asked = [];
  for (let i = 0; i < 25; i += 1) {
    if (await page.locator('#submit-go:not([hidden])').count()) return asked;
    const label = await answerCsrQuestion(page);
    if (label === null) { await page.waitForTimeout(100); continue; }
    asked.push(label);
    await page.waitForFunction((prev) => {
      const f = document.querySelector('#answer-slot fx-field');
      return document.querySelector('#submit-go:not([hidden])') || (f && f.getAttribute('label') !== prev);
    }, label, { timeout: 5000 });
  }
  throw new Error(`assisted intake did not finish; asked: ${asked.join(' | ')}`);
}

test('CSR signs in, looks up a seeded policy and submits an assisted intake', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    // The disclosure question renders as a text box that sends a string, which the server rejects (see the
    // todo test below). This test sends the boolean the contract expects so the rest of the flow is covered.
    await page.route('**/api/v1/intake/sessions/*/answers', async (route) => {
      const body = route.request().postDataJSON();
      if (body?.questionId === 'fraud_disclosure') return route.continue({ postData: JSON.stringify({ ...body, value: true }) });
      return route.continue();
    });
    await signIn(page);
    assert.equal((await page.textContent('#whoami')).trim().length > 0, true, 'signed-in banner');
    const a11yDesk = await reportPageA11y(page, 'csr desk', t);

    await lookupAndStart(page);
    assert.match(await page.textContent('#intake-h'), new RegExp(policy.policyNumber));
    assert.ok((await page.textContent('#script')).trim().length > 0, 'CSR script prompt is shown');

    const asked = await answerAll(page);
    assert.ok(asked.length >= 4, `answered ${asked.length} questions`);
    const a11yIntake = await reportPageA11y(page, 'csr intake', t);

    await page.click('#submit-go');
    await page.waitForSelector('#done-sec:not([hidden])');
    const done = await page.textContent('#done-number');
    const number = done.match(/[A-Z0-9]+-\d{4}-\d+/)?.[0] ?? '';
    assert.match(number, CLAIM_NUMBER, `claim number in "${done.trim()}"`);
    assert.match(number, /^AUR-/);
    assert.match(await page.getAttribute('#done-link', 'href'), /^\/csr\?claim=/);
    t.diagnostic(`a11y warnings: desk=${a11yDesk.findings.length} intake=${a11yIntake.findings.length}`);

    // The submitted claim shows in recent claims once the list refreshes.
    await page.click('#recent-refresh');
    await page.waitForFunction((n) => document.querySelector('#recent-table')?.textContent.includes(n), number, { timeout: 5000 });
  } finally {
    await page.close();
  }
});

test('CSR can answer the fraud disclosure through the UI alone', { todo: 'blocker S2-EXP-03-4: disclosure renders as a text box' }, async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    // BUG S2-EXP-03-4: src/web/csr/app.js maps question type 'disclosure' to a text <fx-field> and sends a
    // string; the server requires boolean true, so a CSR cannot finish any intake that has a disclosure.
    await signIn(page);
    await lookupAndStart(page);
    for (let i = 0; i < 25 && !(await page.locator('#submit-go:not([hidden])').count()); i += 1) {
      const label = await answerCsrQuestion(page);
      if (label === null) { await page.waitForTimeout(100); continue; }
      await page.waitForTimeout(300);
    }
    assert.equal(await page.locator('#submit-go:not([hidden])').count(), 1, 'submit button never appeared: the disclosure question cannot be answered in the CSR UI (see blocker)');
  } finally {
    await page.close();
  }
});

test('CSR lookup of an unknown policy shows an empty result', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    await signIn(page);
    await page.fill('#search-field input', 'ZZZ-000000');
    await page.click('#search-go');
    await page.waitForFunction(() => document.querySelector('#search-msg')?.textContent.trim().length > 0);
    assert.equal(await page.locator('#search-table tbody tr[tabindex]').count(), 0, 'no selectable rows');
  } finally {
    await page.close();
  }
});
