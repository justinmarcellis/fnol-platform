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
async function completeGuided(page, t, lossType) {
  const asked = [];
  await page.check('input[name="lob"][value="personal_auto"]');
  if (lossType) await page.check(`input[name="lossType"][value="${lossType}"]`);
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

test('claimant UI raises no browser errors after submit (status poller)', async (t) => {
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

test('claimant can reach the personal auto glass question set (loss type)', async (t) => {
  if (skip) return t.skip(skip);
  const page = await open();
  try {
    const asked = await completeGuided(page, t, 'glass');
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

test('English-only tenant (Kestrel) does not show the language picker', async (t) => {
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

// ---- S4-EXP-01: structured party sub-form and insured-vehicle picker
const PARTY_FIELDS = { lastName: 'Example', firstName: 'Pat', phone: '(555) 010-0142', insurerName: 'Fictional Mutual', otherPolicyNumber: 'OTH-000123' };

/** Walk the guided flow, answering "another party involved" yes, until the party sub-form shows. Returns the labels asked. */
async function reachPartyForm(page) {
  const asked = [];
  for (let i = 0; i < 25; i += 1) {
    await page.waitForSelector('main form');
    if (await page.locator('fieldset.sf[data-qtype="party"]').count()) return asked;
    const legend = (await page.locator('main form legend, main form label').first().textContent()).trim();
    if (/another vehicle or person/i.test(legend)) {
      await page.check('main form input[value="true"]');
      await page.click('main form button[type="submit"]');
    } else {
      await answerClaimantQuestion(page);
    }
    asked.push(legend);
    await page.waitForFunction((prev) => {
      const l = document.querySelector('main form legend, main form label')?.textContent?.trim();
      return document.querySelector('fieldset.sf') || document.querySelector('#review-title') || l !== prev;
    }, legend, { timeout: 5000 });
  }
  throw new Error(`party question not reached; asked: ${asked.join(' | ')}`);
}

test('claimant party sub-form: labelled controls, object value, 422 shown inline', async (t) => {
  if (skip) return t.skip(skip);
  const page = await open('/claimant?tenant=aurelia-mutual');
  const sent = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/intake\/sessions\/[^/]+\/answers$/.test(r.url())) sent.push(r.postDataJSON()); });
  let rejected = false;
  await page.route('**/intake/sessions/*/answers', async (route) => {
    const body = route.request().postDataJSON();
    if (body.questionId !== 'other_party_info' || rejected) return route.continue();
    rejected = true; // first party answer is rejected as incomplete (synthetic), the retry goes through
    const res = await route.fetch();
    const json = await res.json();
    return route.fulfill({
      status: 422, contentType: 'application/json',
      body: JSON.stringify({ ...json, error: { code: 'validation_failed', message: '1 answer(s) were not accepted' }, errors: [{ questionId: 'other_party_info', message: 'Provide the requested details (synthetic).' }] }),
    });
  });
  try {
    await page.check('input[name="lob"][value="personal_auto"]');
    await page.click('form button[type="submit"]');
    await reachPartyForm(page);
    const fs = page.locator('fieldset.sf[data-qtype="party"]');

    // Every control has a label (for/id), the fieldset has a legend.
    assert.ok((await fs.locator('legend').textContent()).trim().length > 0, 'legend');
    for (const name of ['firstName', 'lastName', 'role', 'phone', 'insurerName', 'otherPolicyNumber', 'atFault']) {
      const id = await fs.locator(`[name="${name}"]`).getAttribute('id');
      assert.equal(await fs.locator(`label[for="${id}"]`).count(), 1, `label for ${name}`);
    }
    const roles = await fs.locator('select[name="role"] option').evaluateAll((os) => os.map((o) => o.value));
    for (const r of ['third_party', 'driver', 'witness']) assert.ok(roles.includes(r), `role ${r}`);
    const a11y = await reportPageA11y(page, 'claimant party sub-form', t);
    t.diagnostic(`a11y warnings: ${a11y.findings.length}`);

    // Incomplete: refused locally, nothing sent.
    const before = sent.length;
    await page.click('main form button[type="submit"]');
    assert.match(await page.textContent('fieldset.sf .field-error'), /./);
    assert.equal(sent.length, before, 'incomplete party is not sent');

    for (const [k, v] of Object.entries(PARTY_FIELDS)) await fs.locator(`[name="${k}"]`).fill(v);
    await fs.locator('select[name="role"]').selectOption('driver');
    await fs.locator('input[name="atFault"]').check();
    await page.click('main form button[type="submit"]');

    // Server 422 shown inline, typed values kept.
    await page.waitForSelector('#q-error');
    assert.match(await page.textContent('#q-error'), /synthetic/);
    assert.equal(await page.locator('fieldset.sf input[name="lastName"]').inputValue(), 'Example');
    const first = sent.at(-1);
    assert.equal(first.questionId, 'other_party_info');
    assert.equal(typeof first.value, 'object');
    assert.deepEqual(first.value.roles, ['driver']);
    assert.equal(first.value.atFault, true);

    await page.click('main form button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('fieldset.sf[data-qtype="party"]'), null, { timeout: 5000 });
    assert.equal(await page.locator('#q-error').count(), 0, 'error cleared after acceptance');
  } finally {
    await page.close();
  }
});

test('claimant insured-vehicle picker lists policy vehicles and sends policyVehicleId and VIN; hidden without vehicles', async (t) => {
  if (skip) return t.skip(skip);
  const policy = server.policies['aurelia-mutual'][0];
  const unit = policy.vehicles[0];
  for (const withVehicles of [true, false]) {
    const page = await open('/claimant?tenant=aurelia-mutual');
    const sent = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /\/intake\/sessions\/[^/]+\/answers$/.test(r.url())) sent.push(r.postDataJSON()); });
    // The claimant role cannot read policy snapshots, so the snapshot is stubbed (synthetic).
    await page.route(`**/api/v1/policies/${policy.policyNumber}/snapshot*`, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ policyNumber: policy.policyNumber, vehicles: withVehicles ? policy.vehicles : [] }),
    }));
    try {
      await page.check('input[name="lob"][value="personal_auto"]');
      await page.fill('#policy-number', policy.policyNumber);
      await page.click('form button[type="submit"]');
      await page.waitForSelector('main form');
      if (!withVehicles) {
        await page.waitForTimeout(300);
        assert.equal(await page.locator('#vehicle-pick').count(), 0, 'picker hidden when the policy has no vehicles');
        continue;
      }
      await page.waitForSelector('#insured-vehicle');
      assert.equal(await page.locator('label[for="insured-vehicle"]').count(), 1, 'picker is labelled');
      assert.equal(await page.locator('#insured-vehicle option[value]:not([value=""])').count(), policy.vehicles.length);
      await page.selectOption('#insured-vehicle', unit.unitId);
      await page.waitForFunction(() => document.activeElement?.id === 'insured-vehicle');
      const pick = sent.find((b) => b.value?.policyVehicleId === unit.unitId);
      assert.ok(pick, 'insured vehicle answer sent');
      assert.equal(pick.value.vin, unit.vin);
      assert.equal(await page.locator('#insured-vehicle').inputValue(), unit.unitId, 'selection survives the re-render');
      const a11y = await reportPageA11y(page, 'claimant vehicle picker', t);
      t.diagnostic(`a11y warnings: ${a11y.findings.length}`);
    } finally {
      await page.close();
    }
  }
});

// ---- S4-EXP-01 rework: the pick must reach the claim, a failed pick must be visible, and real claimant tokens must not break the page
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePolicies } from '../synthetic/index.mjs';

async function bootWithVehicleQuestion() {
  const { createApp } = await import('../../src/server.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-clm-veh-'));
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
  const pols = generatePolicies({ tenantId: 'aurelia-mutual', lob: 'personal_auto', count: 3, seed: 7, state: 'WI' });
  await app.ctx.forTenant('aurelia-mutual').modules.coverage.seedPolicies(pols);
  return { app, pols, async close() { try { await app.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } } };
}

const stubSnapshot = (page, policy) => page.route(`**/api/v1/policies/${policy.policyNumber}/snapshot*`, (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify({ policyNumber: policy.policyNumber, vehicles: policy.vehicles }),
}));

async function startWithPolicy(page, policy) {
  await page.check('input[name="lob"][value="personal_auto"]');
  await page.fill('#policy-number', policy.policyNumber);
  await page.click('form button[type="submit"]');
  await page.waitForSelector('main form');
}

test('claimant insured-vehicle pick is stored on the claim as vehicles[role=insured] (tenant with an insured_vehicle question)', async (t) => {
  if (skip) return t.skip(skip);
  const alt = await bootWithVehicleQuestion();
  const pol = alt.pols[0];
  const unit = pol.vehicles[pol.vehicles.length - 1];
  const page = await browser.newPage();
  try {
    await page.goto(`${alt.app.url}/claimant?tenant=aurelia-mutual`);
    await page.waitForSelector('input[name="lob"]');
    await stubSnapshot(page, pol); // claimants cannot read snapshots yet (contract-change pending): synthetic stub
    await startWithPolicy(page, pol);
    await page.waitForSelector('#insured-vehicle');
    await page.selectOption('#insured-vehicle', unit.unitId);
    await page.waitForFunction(() => document.activeElement?.id === 'insured-vehicle');
    assert.equal(await page.locator('#vehicle-error:not([hidden])').count(), 0, 'no failure when the server accepts the pick');
    for (let i = 0; i < 25 && !(await page.locator('#review-title').count()); i += 1) {
      const q = await answerClaimantQuestion(page);
      await page.waitForFunction((prev) => {
        const l = (document.querySelector('main legend, main form label') ?? {}).textContent?.trim();
        return document.querySelector('#review-title') || l !== prev;
      }, q, { timeout: 5000 });
    }
    await page.click('#review-title ~ button');
    await page.waitForSelector('#claim-number');
    const number = (await page.textContent('#claim-number')).trim();
    const list = await alt.app.ctx.forTenant('aurelia-mutual').modules.claims.listClaims({});
    const row = (list.items ?? list).find((c) => c.claimNumber === number);
    assert.ok(row, 'claim found');
    const claim = await alt.app.ctx.forTenant('aurelia-mutual').modules.claims.getClaim(row.id, { include: ['vehicles'] });
    const insured = (claim.vehicles ?? []).filter((v) => v.role === 'insured');
    assert.equal(insured.length, 1, 'claim carries one insured vehicle');
    assert.equal(insured[0].vin, unit.vin);
  } finally {
    await page.close();
    await alt.close();
  }
});

test('claimant sees an alert when the vehicle pick is rejected (shipped tenants have no such question)', async (t) => {
  if (skip) return t.skip(skip);
  const policy = server.policies['aurelia-mutual'][0];
  const page = await open('/claimant?tenant=aurelia-mutual');
  try {
    await stubSnapshot(page, policy);
    await startWithPolicy(page, policy);
    await page.waitForSelector('#insured-vehicle');
    await page.selectOption('#insured-vehicle', policy.vehicles[0].unitId);
    await page.waitForSelector('#vehicle-error[role="alert"]:not([hidden])');
    assert.match(await page.textContent('#vehicle-error'), /could not save your vehicle choice/i);
  } finally {
    await page.close();
  }
});

test('claimant with a real token (no snapshot access) sees no picker and no error', async (t) => {
  if (skip) return t.skip(skip);
  const policy = server.policies['aurelia-mutual'][0];
  const page = await open('/claimant?tenant=aurelia-mutual');
  try {
    await startWithPolicy(page, policy);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#vehicle-pick').count(), 0, 'picker hidden when the claimant cannot read the policy');
    assert.equal(page.pageErrors.length, 0);
  } finally {
    await page.close();
  }
});
