// Playwright smoke for /csr: dev login, policy lookup, assisted intake submit. Skips cleanly without Playwright.
// a11y findings are warnings only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, bootApp, answerCsrQuestion, reportPageA11y, CLAIM_NUMBER, ROOT } from './a11y-harness.mjs';

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

/** Sign in the way a demo user does: pick the CSR persona in <fx-demo-bar>. There is no separate dev form any more. */
async function signIn(page, tenant = TENANT) {
  await page.goto(`${server.app.url}/csr?tenant=${tenant}`);
  assert.equal(await page.locator('#dev-form').count(), 0, 'the old dev sign-in form is gone');
  await page.waitForSelector(`fx-demo-bar #fxd-persona option[value="${tenant}:csr"]`, { state: 'attached' });
  await page.selectOption('#fxd-persona', `${tenant}:csr`);
  await page.waitForURL('**/csr');
  await page.waitForSelector('#desk:not([hidden])');
}

/** Which question is on screen (set by the app on #answer-slot). */
const currentQid = (page) => page.getAttribute('#answer-slot', 'data-qid');

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
  await page.waitForSelector('#answer-slot[data-qid]:not([data-qid=""])');
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

/**
 * Wait until the question that was on screen (`qid`) has been replaced, or the submit button shows.
 * S6-EXP-04 root cause of the intermittent rear-end failure: this used to compare the first fx-field label with the
 * previous label. For a multi-field sub-form (party) the first field label never equals the legend text, so the wait
 * returned at once; under load the next step then filled and submitted the STILL-VISIBLE old form while the server was
 * replying, and the form was swapped out from under the locators (30 s timeout). Question identity is the contract.
 */
async function waitForNext(page, qid) {
  await page.waitForFunction((prev) => {
    if (document.querySelector('#submit-go:not([hidden])')) return true;
    const cur = document.querySelector('#answer-slot')?.dataset.qid;
    return !!cur && cur !== prev;
  }, qid, { timeout: 15000 });
}

/** Answer until the submit button shows. Returns the labels answered. */
async function answerAll(page) {
  const asked = [];
  for (let i = 0; i < 25; i += 1) {
    if (await page.locator('#submit-go:not([hidden])').count()) return asked;
    const qid = await currentQid(page);
    const label = await answerQuestion(page);
    if (label === null) { await page.waitForTimeout(100); continue; }
    asked.push(label);
    await waitForNext(page, qid);
  }
  throw new Error(`assisted intake did not finish; asked: ${asked.join(' | ')}`);
}

test('CSR signs in, looks up a seeded policy and submits an assisted intake', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    await signIn(page);
    assert.ok((await page.getAttribute('fx-app-shell', 'user-name'))?.trim(), 'signed-in user shown in the shell');
    assert.equal(await page.locator('fx-demo-bar').count(), 1, 'demo bar is in the page');
    const a11yDesk = await reportPageA11y(page, 'csr desk', t);

    await lookupAndStart(page);
    assert.match(await page.textContent('#intake-card h2'), new RegExp(policy.policyNumber));
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
    // Recent claims: status chip, humanized date and line-of-business label (not raw tokens or ISO strings).
    const recentRow = page.locator('#recent-table tbody tr', { hasText: number });
    assert.ok(await recentRow.locator('fx-badge').count(), 'status is a chip');
    assert.ok(!/T\d\d:\d\d/.test(await recentRow.textContent()), 'reported date is humanized');
    assert.match(await recentRow.textContent(), /Personal auto/, 'line of business is a label, not personal_auto');
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
      const qid = await currentQid(page);
      const label = await answerQuestion(page);
      if (label === null) { await page.waitForTimeout(100); continue; }
      await waitForNext(page, qid);
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
// The adjuster workbench is another team's UI (it moves to the demo bar in its own ticket), so this test signs in
// through the stable seams only: a dev token from POST /auth/token, stored where the app reads it on load.
const adjusterSignIn = async (page) => {
  const res = await fetch(`${server.app.url}/api/v1/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId: TENANT, userId: 'adj-csr-test', sub: 'adj-csr-test', roles: ['adjuster'], displayName: 'Test Adjuster', name: 'Test Adjuster' }),
  });
  const { token } = await res.json();
  assert.ok(token, 'dev adjuster token minted');
  await page.addInitScript((tk) => { try { sessionStorage.setItem('adjuster.token', tk); } catch { /* ignore */ } }, token);
};

/** Answer the question on screen. Rear-end path: another party is involved and is at fault. Returns a label or null. */
async function answerRearEnd(page, sentLog) {
  const partyForm = page.locator('#answer-slot fieldset.sf[data-qtype="party"]');
  if (await partyForm.count()) {
    // S5-QE-03: act on the same locator that was checked; the unfiltered fieldset.sf can resolve to a
    // different sub-form while the slot re-renders under load (the 30 s lastName timeout).
    const fs = partyForm;
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

    // Insured vehicle picker lists the policy vehicles; the pick carries policyVehicleId (list comes from GET /intake/sessions/{id}/policy-vehicles).
    await page.waitForSelector('#vehicle-pick:not([hidden]) select');
    const options = await page.locator('#vehicle-pick select option[value]:not([value=""])').count();
    assert.ok(options >= 1, 'policy vehicles are listed');
    const unit = policy.vehicles[0];
    await page.selectOption('#vehicle-pick select', unit.unitId);
    await page.waitForFunction(() => document.querySelector('#vehicle-picked')?.textContent.trim().length > 0);
    const veh = sent.find((b) => b.value && b.value.policyVehicleId === unit.unitId);
    assert.ok(veh, 'insured vehicle answer was sent');

    let sawParty = false;
    for (let i = 0; i < 25 && !(await page.locator('#submit-go:not([hidden])').count()); i += 1) {
      const qid = await currentQid(page);
      const label = await answerRearEnd(page, log);
      if (label === null) { await page.waitForTimeout(100); continue; }
      if (log.partyLabel) sawParty = true;
      await waitForNext(page, qid);
    }
    assert.ok(sawParty, 'the party question rendered as a sub-form');
    const party = sent.find((b) => b.questionId === 'other_party_info');
    assert.ok(party, 'party answer was sent');
    assert.equal(typeof party.value, 'object');
    assert.deepEqual(party.value.roles, ['third_party']);
    assert.equal(party.value.lastName, 'Example');
    assert.equal(party.value.atFault, true);
    assert.strictEqual(sent.find((b) => b.questionId === 'other_party_involved')?.value, true);
    // Buttons fade their colours in when they appear; scan only once the final colours are painted.
    await page.waitForFunction(() => ['submit-go', 'answer-go'].every((id) => { const b = document.getElementById(id); return b.hidden || b.closest('[hidden]') || getComputedStyle(b).backgroundColor !== 'rgb(255, 255, 255)'; }));
    await page.waitForTimeout(250);
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
      const qid = await currentQid(page);
      const label = await answerRearEnd(page, {});
      if (label === null) { await page.waitForTimeout(100); continue; }
      await waitForNext(page, qid);
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

// ---- S4-EXP-01 round 3: the insured-vehicle pick (shipped tenants) must reach the claim
test('CSR insured-vehicle pick is stored on the claim as vehicles[role=insured] (shipped tenants)', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  try {
    const pol = policy;
    const unit = pol.vehicles[pol.vehicles.length - 1]; // not necessarily the default first unit
    const ln = pol.namedInsureds[0].name.split(' ').pop();
    await signIn(page);
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
    const claim = await server.app.ctx.forTenant(TENANT).modules.claims.getClaim(claimId, { include: ['vehicles'] });
    const insured = (claim.vehicles ?? []).filter((v) => v.role === 'insured');
    assert.equal(insured.length, 1, 'claim carries one insured vehicle');
    assert.equal(insured[0].vin, unit.vin);
  } finally {
    await page.close();
  }
});


// ---- S6-EXP-04: two-pane desk
test('search is type-ahead, the keyboard selects, and the context panel sits beside the intake', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await signIn(page);
    // Typing alone (no Search click) fetches results as a table.
    const searched = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/v1/policies');
    await page.locator('#search-field input').pressSequentially(lastName);
    assert.equal(new URL((await searched).url()).searchParams.get('q')?.length > 1, true, 'type-ahead query sent');
    const row = page.locator('#search-table tbody tr[tabindex]', { hasText: policy.policyNumber });
    await row.waitFor();
    assert.equal(await page.locator('#search-table table thead th').count() >= 4, true, 'results are a proper table with headers');
    // Keyboard: ArrowDown from the box lands on the first row, which shows a visible focus ring; Enter selects.
    await page.locator('#search-field input').press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.matches('#search-table tbody tr')), true, 'focus moved to a result row');
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none', 'focused row has a visible outline');
    for (let i = 0; i < 5; i += 1) { // land on the wanted policy (rows are ordered by the server)
      if ((await page.evaluate(() => document.activeElement?.textContent ?? '')).includes(policy.policyNumber)) break;
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
    await page.waitForSelector('#intake-sec:not([hidden])');
    await page.waitForSelector('#answer-slot[data-qid]:not([data-qid=""])');

    // Left context panel: policy, named insured, vehicles, coverages as cards with status chips.
    const ctx = page.locator('#context-panel');
    await ctx.locator('.csr-tile[data-coverage]').first().waitFor();
    assert.match(await ctx.textContent(), new RegExp(policy.policyNumber));
    assert.match(await ctx.textContent(), new RegExp(policy.namedInsureds[0].name));
    assert.equal(await ctx.locator('.csr-tile[data-unit]').count(), policy.vehicles.length, 'a card per vehicle');
    assert.equal(await ctx.locator('.csr-tile[data-coverage]').count(), policy.coverages.length, 'a card per coverage');
    assert.ok(await ctx.locator('.csr-tile[data-coverage] fx-badge').count(), 'coverage cards carry status chips');
    // Two panes side by side at 1440 px.
    const boxes = await page.evaluate(() => ['#context-panel', '#intake-card'].map((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.x, w: r.width, y: r.y }; }));
    assert.ok(boxes[0].x + boxes[0].w <= boxes[1].x + 1, 'context panel is left of the intake');
    assert.ok(Math.abs(boxes[0].y - boxes[1].y) < 4, 'panes share a top edge');
    // Progress indicator moves as answers land.
    const before = Number(await page.getAttribute('#progress-bar', 'aria-valuenow'));
    const qid = await currentQid(page);
    await answerQuestion(page);
    await waitForNext(page, qid);
    const after = Number(await page.getAttribute('#progress-bar', 'aria-valuenow'));
    assert.ok(after > before, `progress ${before} -> ${after}`);
  } finally {
    await page.close();
  }
});

// ---- S5-QE-03 carry-over regression: a slow server (what full-suite load looks like) must not break the flow
test('rear-end intake is stable when the server is slow and never sends an answer twice', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  const sent = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/intake\/sessions\/[^/]+\/answers$/.test(r.url())) sent.push(r.postDataJSON().questionId); });
  try {
    await signIn(page);
    await page.route('**/intake/sessions/*/answers', async (route) => { await new Promise((r) => setTimeout(r, 900)); await route.continue(); });
    await lookupAndStart(page);
    for (let i = 0; i < 25 && !(await page.locator('#submit-go:not([hidden])').count()); i += 1) {
      const qid = await currentQid(page);
      const label = await answerRearEnd(page, {});
      if (label === null) { await page.waitForTimeout(100); continue; }
      // While the server is still replying the answer button is disabled, so a second click cannot re-send.
      await page.click('#answer-go', { timeout: 300, force: true }).catch(() => {});
      await waitForNext(page, qid);
    }
    assert.equal(await page.locator('#submit-go:not([hidden])').count(), 1, 'intake finished');
    const dupes = sent.filter((q, i) => sent.indexOf(q) !== i);
    assert.deepEqual(dupes, [], `no question answered twice: ${sent.join(',')}`);
  } finally {
    await page.close();
  }
});

// ---- S6-EXP-04 screenshots (1440x900): search, context + intake, recent claims. Reviewed by eye against docs/design/before/csr*.png.
test('CSR desk screenshots at 1440x900', async (t) => {
  if (skip) return t.skip(skip);
  const outDir = path.join(ROOT, 'docs', 'design', 'screens');
  fs.mkdirSync(outDir, { recursive: true });
  const claims = server.app.ctx.forTenant(TENANT).modules.claims;
  const seeded = [['reported', 0], ['triaged', 1], ['in_review', 2], ['pending_info', 3], ['closed', 9]];
  const ids = [];
  for (const [status] of seeded) {
    const c = await claims.createClaim({ lob: 'personal_auto', channel: 'csr_phone', riskState: 'WI', policyNumber: policy.policyNumber, idempotencyKey: `shot-${status}`,
      lossEvent: { lossDate: '2026-10-01', cause: 'collision', description: 'Synthetic screenshot claim.' } }, { actor: 'test' });
    ids.push(c.id);
  }
  await server.app.ctx.bus.drain(); // routing and triage settle first so the statuses below are the final ones
  seeded.forEach(([status, i], k) => {
    {
      const at = new Date(Date.now() - (i * 26 + 1) * 3600 * 1000 - i * 777000).toISOString();
      server.app.ctx.forTenant(TENANT).db.run("UPDATE claims SET status = ?, reported_at = ?, doc = json_set(doc, '$.status', ?, '$.reportedAt', ?) WHERE id = ?", status, at, status, at, ids[k]);
    }
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await signIn(page);
    await page.waitForFunction(() => document.querySelectorAll('#recent-table tbody tr[tabindex]').length >= 5);
    await page.locator('#recent-sec').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, 'csr-recent.png') });
    await page.evaluate(() => window.scrollTo(0, 0));

    await page.fill('#search-field input', lastName);
    await page.locator('#search-table tbody tr[tabindex]', { hasText: policy.policyNumber }).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, 'csr-search.png') });

    await page.locator('#search-table tbody tr[tabindex]', { hasText: policy.policyNumber }).click();
    await page.locator('#context-panel .csr-tile[data-coverage]').first().waitFor();
    await page.waitForSelector('#vehicle-pick:not([hidden]) select');
    await page.selectOption('#vehicle-pick select', policy.vehicles[0].unitId);
    await page.waitForFunction(() => document.querySelector('#vehicle-picked')?.textContent.trim().length > 0);
    for (let i = 0; i < 2; i += 1) { const qid = await currentQid(page); await answerQuestion(page); await waitForNext(page, qid); }
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'csr-context-intake.png') });
    for (const n of ['csr-search', 'csr-context-intake', 'csr-recent']) assert.ok(fs.statSync(path.join(outDir, `${n}.png`)).size > 20000, `${n}.png written`);
  } finally {
    await ctx.close();
  }
});
