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

// ---- S4-EXP-01: structured party answer, insured-vehicle pick and the Aurelia subrogation path
const adjusterSignIn = async (page) => {
  await page.goto(`${server.app.url}/adjuster`);
  await page.waitForSelector('#dev-form');
  await page.click('#dev-go');
  await page.waitForSelector('#inbox-sec:not([hidden])');
};

/** Answer the question on screen. Rear-end path: another party is involved and is at fault. Returns a label or null. */
async function answerRearEnd(page, sentLog) {
  if (await page.locator('#answer-slot fieldset.sf[data-qtype="party"]').count()) {
    const fs = page.locator('#answer-slot fieldset.sf');
    await fs.locator('input[name="lastName"]').fill('Example');
    await fs.locator('input[name="firstName"]').fill('Pat');
    await fs.locator('select[name="role"]').selectOption('third_party');
    await fs.locator('input[name="phone"]').fill('(555) 010-0142');
    await fs.locator('input[name="insurerName"]').fill('Fictional Mutual');
    await fs.locator('input[name="otherPolicyNumber"]').fill('OTH-000123');
    await fs.locator('input[type=checkbox][name="atFault"]').check();
    sentLog.partyLabel = await fs.locator('legend').textContent();
    await page.click('#answer-go');
    return sentLog.partyLabel;
  }
  const f = page.locator('#answer-slot fx-field');
  if (await f.count() && /another vehicle or person/i.test((await f.getAttribute('label')) ?? '')) {
    const label = await f.getAttribute('label');
    await f.locator('select').selectOption('true');
    await page.click('#answer-go');
    return label;
  }
  return answerQuestion(page);
}

test('CSR rear-end claim with an at-fault other driver reaches the subrogation flag in the adjuster view', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  const sent = [];
  const log = {};
  page.on('request', (r) => { if (r.method() === 'POST' && /\/intake\/sessions\/[^/]+\/answers$/.test(r.url())) sent.push(r.postDataJSON()); });
  try {
    await signIn(page);
    await lookupAndStart(page);

    // Insured vehicle picker lists the policy vehicles; the pick carries policyVehicleId and VIN.
    await page.waitForSelector('#vehicle-pick:not([hidden]) select');
    const options = await page.locator('#vehicle-pick select option[value]:not([value=""])').count();
    assert.ok(options >= 1, 'policy vehicles are listed');
    const unit = policy.vehicles[0];
    await page.selectOption('#vehicle-pick select', unit.unitId);
    await page.waitForFunction(() => document.querySelector('#vehicle-picked')?.textContent.trim().length > 0);
    const veh = sent.find((b) => b.value && b.value.policyVehicleId === unit.unitId);
    assert.ok(veh, 'insured vehicle answer was sent');
    assert.equal(veh.value.vin, unit.vin);

    let sawParty = false;
    for (let i = 0; i < 25 && !(await page.locator('#submit-go:not([hidden])').count()); i += 1) {
      const label = await answerRearEnd(page, log);
      if (label === null) { await page.waitForTimeout(100); continue; }
      if (log.partyLabel) sawParty = true;
      await waitForNext(page, label);
    }
    assert.ok(sawParty, 'the party question rendered as a sub-form');
    const party = sent.find((b) => b.questionId === 'other_party_info');
    assert.ok(party, 'party answer was sent');
    assert.equal(typeof party.value, 'object');
    assert.deepEqual(party.value.roles, ['third_party']);
    assert.equal(party.value.lastName, 'Example');
    assert.equal(party.value.atFault, true);
    assert.strictEqual(sent.find((b) => b.questionId === 'other_party_involved')?.value, true);
    const a11y = await reportPageA11y(page, 'csr structured intake', t);
    t.diagnostic(`a11y warnings: ${a11y.findings.length}`);

    await page.click('#submit-go');
    await page.waitForSelector('#done-sec:not([hidden])');
    const claimId = decodeURIComponent((await page.getAttribute('#done-link', 'href')).split('claim=')[1]);

    const adj = await browser.newPage();
    try {
      await adjusterSignIn(adj);
      await adj.goto(`${server.app.url}/adjuster#/claim/${claimId}`);
      await adj.waitForSelector('#panel-triage');
      // The post-routing rule PR-SUBRO-AUTO flags the claim and opens a subrogation_review task.
      await adj.waitForFunction(() => /subrogation/i.test(document.querySelector('#panel-tasks')?.textContent ?? '') || document.querySelector('[data-flag="subrogation_candidate"]'), null, { timeout: 8000 });
      const text = `${await adj.textContent('#panel-tasks')} ${await adj.locator('[data-flag]').allTextContents()}`;
      assert.match(text, /subrogation/i, 'subrogation flag or task is visible to the adjuster');
    } finally {
      await adj.close();
    }
  } finally {
    await page.close();
  }
});

test('CSR party sub-form shows the server 422 inline', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    await signIn(page);
    // Make the server reject the party answer as incomplete (the real intake API only requires an object).
    await page.route('**/intake/sessions/*/answers', async (route) => {
      const body = route.request().postDataJSON();
      if (body.questionId !== 'other_party_info') return route.continue();
      const res = await route.fetch();
      const json = await res.json();
      return route.fulfill({
        status: 422, contentType: 'application/json',
        body: JSON.stringify({ ...json, error: { code: 'validation_failed', message: '1 answer(s) were not accepted' }, errors: [{ questionId: 'other_party_info', message: 'Provide the requested details (synthetic).' }] }),
      });
    });
    await lookupAndStart(page);
    for (let i = 0; i < 25 && !(await page.locator('#answer-slot fieldset.sf').count()); i += 1) {
      const label = await answerRearEnd(page, {});
      if (label === null) { await page.waitForTimeout(100); continue; }
      await waitForNext(page, label);
    }
    // Client-side check: an empty party is refused before anything is sent.
    await page.click('#answer-go');
    assert.match(await page.textContent('#answer-slot .sf-error'), /./);
    await page.locator('#answer-slot input[name="lastName"]').fill('Example');
    await page.click('#answer-go');
    await page.waitForFunction(() => /synthetic/.test(document.querySelector('#answer-slot .sf-error')?.textContent ?? ''), null, { timeout: 5000 }).catch(async (e) => { throw new Error(`${e.message} | error text: ${await page.textContent('#answer-slot .sf-error')} | fields: ${await page.evaluate(() => [...document.querySelectorAll('#answer-slot fx-field')].map((f) => f.getAttribute('name') + '=' + JSON.stringify(f.value) + ' err=' + f.getAttribute('error')).join('; '))}`); });
    assert.equal(await page.locator('#answer-slot fieldset.sf').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#answer-slot input[name="lastName"]').inputValue(), 'Example', 'typed values are kept');
  } finally {
    await page.close();
  }
});

// ---- S4-EXP-01 rework: the insured-vehicle pick must reach the claim, and a failed pick must be visible
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePolicies } from '../synthetic/index.mjs';

/**
 * Boot an app on a copy of the shipped tenants whose personal_auto question sets also carry the optional
 * 'insured_vehicle' (type vehicle) question requested from the architecture hub. Synthetic data only.
 */
async function bootWithVehicleQuestion() {
  const { createApp } = await import('../../src/server.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-csr-veh-'));
  const tenantsDir = path.join(root, 'tenants');
  fs.mkdirSync(tenantsDir);
  const src = path.resolve(import.meta.dirname, '..', '..', 'tenants');
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.json'))) {
    const cfg = JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));
    for (const qs of cfg.questionSets ?? []) {
      if (qs.lob === 'personal_auto') qs.questions.push({ id: 'insured_vehicle', text: { en: 'Which insured vehicle was involved?', es: 'Que vehiculo asegurado estuvo involucrado?' }, type: 'vehicle', required: false, order: 5, section: 'loss' });
    }
    fs.writeFileSync(path.join(tenantsDir, f), JSON.stringify(cfg));
  }
  const app = await createApp({ dbPath: path.join(root, 'ui.db'), port: 0, secretsDir: path.join(root, 'secrets'), tenantsDir, logLevel: 'silent', devMode: true });
  const pols = generatePolicies({ tenantId: TENANT, lob: 'personal_auto', count: 3, seed: 7, state: 'WI' });
  await app.ctx.forTenant(TENANT).modules.coverage.seedPolicies(pols);
  return { app, pols, async close() { try { await app.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } } };
}

test('CSR insured-vehicle pick is stored on the claim as vehicles[role=insured] (tenant with an insured_vehicle question)', async (t) => {
  if (skip) return t.skip(skip);
  const alt = await bootWithVehicleQuestion();
  const page = await browser.newPage();
  try {
    const pol = alt.pols[0];
    const unit = pol.vehicles[pol.vehicles.length - 1]; // not the default first unit, so enrichment alone cannot explain a match
    const ln = pol.namedInsureds[0].name.split(' ').pop();
    await page.goto(`${alt.app.url}/csr?tenant=${TENANT}`);
    await page.waitForSelector('#dev-form:not([hidden])');
    await page.selectOption('#dev-tenant', TENANT);
    await page.click('#dev-go');
    await page.waitForSelector('#desk:not([hidden])');
    await page.fill('#search-field input', ln);
    await page.click('#search-go');
    const row = page.locator('#search-table tbody tr[tabindex]', { hasText: pol.policyNumber });
    await row.waitFor();
    await row.click();
    await page.waitForSelector('#vehicle-pick:not([hidden]) select');
    await page.selectOption('#vehicle-pick select', unit.unitId);
    await page.waitForFunction(() => document.querySelector('#vehicle-picked')?.textContent.trim().length > 0);
    assert.equal(await page.getAttribute('#vehicle-picked', 'role'), 'status', 'no failure shown when the server accepts the pick');
    await answerAll(page);
    await page.click('#submit-go');
    await page.waitForSelector('#done-sec:not([hidden])');
    const claimId = decodeURIComponent((await page.getAttribute('#done-link', 'href')).split('claim=')[1]);
    const claim = await alt.app.ctx.forTenant(TENANT).modules.claims.getClaim(claimId, { include: ['vehicles'] });
    const insured = (claim.vehicles ?? []).filter((v) => v.role === 'insured');
    assert.equal(insured.length, 1, 'claim carries one insured vehicle');
    assert.equal(insured[0].vin, unit.vin);
  } finally {
    await page.close();
    await alt.close();
  }
});

test('CSR shows an alert when the insured-vehicle pick is rejected (shipped tenants have no such question)', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    await signIn(page);
    await lookupAndStart(page);
    await page.waitForSelector('#vehicle-pick:not([hidden]) select');
    await page.selectOption('#vehicle-pick select', policy.vehicles[0].unitId);
    await page.waitForFunction(() => document.querySelector('#vehicle-picked')?.getAttribute('role') === 'alert');
    assert.match(await page.textContent('#vehicle-picked'), /could not be recorded/i);
  } finally {
    await page.close();
  }
});
