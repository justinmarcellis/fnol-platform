// Playwright smoke for /csr: dev login, policy lookup, assisted intake submit. Skips cleanly without Playwright.
// a11y findings are warnings only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, bootApp, answerCsrQuestion, reportPageA11y, CLAIM_NUMBER } from './a11y-harness.mjs';

const TENANT = 'aurelia-mutual';
let server; let browser; let skip; let policy; let lastName;

before(async () => {
  const launched = await launchBrowser();
  if (launched.skip) { skip = launched.skip; return; }
  browser = launched.browser;
  server = await bootApp();
  policy = server.policies[TENANT][0];
  lastName = policy.namedInsureds[0].name.split(' ').pop();
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
  await page.fill('#search-field input', lastName);
  const searched = page.waitForRequest((r) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/v1/policies');
  await page.click('#search-go');
  assert.equal(new URL((await searched).url()).searchParams.get('q'), lastName, 'search uses GET /policies?q=');
  const row = page.locator('#search-table tbody tr[tabindex]', { hasText: policy.policyNumber });
  await row.waitFor();
  assert.match(await page.textContent('#search-msg'), /\d/, 'result count shown');
  assert.ok((await row.textContent()).includes(policy.policyNumber), 'result row shows the policy number');
  await row.click();
  await page.waitForSelector('#answer-slot fx-field');
}

/** Answer the current question through the UI. Disclosures are acknowledged by ticking the checkbox. Returns a label or null. */
async function answerQuestion(page) {
  const box = page.locator('#answer-slot input[type=checkbox]');
  if (await box.count()) {
    const label = (await page.textContent('#answer-slot label')).trim();
    await box.check();
    await page.click('#answer-go');
    return label;
  }
  return answerCsrQuestion(page);
}

/** Wait for the question after `label` (fx-field label or checkbox label), or for the submit button. */
async function waitForNext(page, label) {
  await page.waitForFunction((prev) => {
    if (document.querySelector('#submit-go:not([hidden])')) return true;
    const f = document.querySelector('#answer-slot fx-field');
    const cur = f ? f.getAttribute('label') : document.querySelector('#answer-slot .fx-check label')?.textContent.trim();
    return cur !== undefined && cur !== prev;
  }, label, { timeout: 5000 });
}

/** Answer until the submit button shows. Returns the labels answered. */
async function answerAll(page) {
  const asked = [];
  for (let i = 0; i < 25; i += 1) {
    if (await page.locator('#submit-go:not([hidden])').count()) return asked;
    const label = await answerQuestion(page);
    if (label === null) { await page.waitForTimeout(100); continue; }
    asked.push(label);
    await waitForNext(page, label);
  }
  throw new Error(`assisted intake did not finish; asked: ${asked.join(' | ')}`);
}

test('CSR signs in, looks up a seeded policy and submits an assisted intake', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
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

test('CSR can answer the fraud disclosure through the UI alone', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  const sent = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/intake\/sessions\/[^/]+\/answers$/.test(r.url())) sent.push(r.postDataJSON()); });
  try {
    await signIn(page);
    await lookupAndStart(page);
    // Required-items panel lists IntakeStep.missing[] entries and shrinks as answers land.
    const first = await page.locator('#missing li').count();
    assert.ok(first >= 2, `panel lists ${first} required items`);
    let sawCheckbox = false;
    for (let i = 0; i < 25 && !(await page.locator('#submit-go:not([hidden])').count()); i += 1) {
      const box = page.locator('#answer-slot input[type=checkbox]');
      if (await box.count()) {
        sawCheckbox = true;
        assert.equal(await box.getAttribute('aria-required'), 'true');
        assert.ok((await page.textContent('#answer-slot label')).trim().length > 0, 'checkbox is labelled');
        assert.equal(await page.locator('#answer-slot label[for]').count(), 1);
        await page.click('#answer-go');
        assert.equal(sent.some((b) => b.questionId === 'fraud_disclosure'), false, 'unticked disclosure is not sent');
        assert.equal(await box.getAttribute('aria-invalid'), 'true');
      }
      const before = await page.locator('#missing li').count();
      const label = await answerQuestion(page);
      if (label === null) { await page.waitForTimeout(100); continue; }
      await waitForNext(page, label);
      if (!sawCheckbox) {
        const after = await page.locator('#missing li').count();
        assert.ok(after <= before, 'panel does not grow while answering');
      }
    }
    assert.ok(sawCheckbox, 'the disclosure rendered as a checkbox');
    const d = sent.find((b) => b.questionId === 'fraud_disclosure');
    assert.ok(d, 'disclosure answer was sent');
    assert.strictEqual(d.value, true, 'disclosure value is boolean true');
    assert.equal(await page.locator('#submit-go:not([hidden])').count(), 1, 'submit button appears after the disclosure');
    assert.match(await page.textContent('#missing'), /./);
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
