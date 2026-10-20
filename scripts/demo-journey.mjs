// Two-persona demo journey (docs/demo-journey.md): a policyholder reports a collision on the web, the adjuster asks for
// photos, the policyholder answers from the claim status page, the adjuster sees the photo and resumes the review.
// Drives Chromium against a running app and writes one screenshot per beat. Start the app first
// (FNOL_DEV_MODE=1 PORT=<port> FNOL_DB_PATH=<tmp db> node scripts/dev.mjs), then:
//   node scripts/demo-journey.mjs <out dir> http://localhost:<port> [tenant]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const out = process.argv[2] ?? 'journey-out';
const base = process.argv[3] ?? 'http://localhost:8080';
const tenant = process.argv[4] ?? 'aurelia-mutual';
fs.mkdirSync(out, { recursive: true });

const personas = (await (await fetch(`${base}/api/v1/dev/personas`)).json()).tenants.find((t) => t.id === tenant).personas;
const claimant = personas.find((p) => p.role === 'claimant');
const adjuster = personas.find((p) => p.role === 'adjuster');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const problems = [];
const watch = (p, who) => {
  p.on('pageerror', (e) => problems.push(`${who} pageerror: ${e.message}`));
  p.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) problems.push(`${who} http ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
};
let n = 0;
const shot = (p, name) => p.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true });
const step = (msg) => console.log(`- ${msg}`);

/** Sign in through the Demo bar, as the sponsor does. */
async function signIn(p, persona) {
  await p.goto(`${base}/`);
  await p.waitForSelector('#fxd-tenant:not([disabled])', { state: 'attached', timeout: 15000 });
  // Below 768 px the bar folds behind a Switch button.
  if (await p.locator('.fxd-toggle').isVisible()) await p.click('.fxd-toggle');
  await p.selectOption('#fxd-tenant', tenant);
  await p.waitForFunction((id) => [...document.querySelectorAll('#fxd-persona option')].some((o) => o.value === id), persona.id);
  await Promise.all([p.waitForEvent('load'), p.selectOption('#fxd-persona', persona.id)]);
}

/** Realistic synthetic answers for the guided collision questions. */
async function answer(p) {
  return p.evaluate(() => {
    const form = document.querySelector('main form');
    if (!form) return null;
    const fs = form.querySelector('fieldset');
    const label = (fs?.querySelector('legend') ?? form.querySelector('label'))?.textContent?.trim() ?? '';
    const fire = (el) => el.dispatchEvent(new Event('change', { bubbles: true }));
    if (fs) {
      const boxes = [...fs.querySelectorAll('input')];
      const pick = boxes[0].type === 'checkbox' ? boxes[0] : (boxes.find((i) => i.value === 'false') ?? boxes[0]);
      pick.checked = true; fire(pick);
    } else {
      const c = form.querySelector('input,select,textarea');
      const d = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
      if (c.tagName === 'SELECT') c.value = [...c.options].find((o) => o.value)?.value ?? '';
      else if (c.type === 'date') c.value = d;
      else if (c.type === 'number') c.value = '1';
      else if (c.type === 'tel') c.value = '(555) 010-0155';
      else if (c.type === 'email') c.value = 'policyholder@example.test';
      else c.value = 'I was parked outside the grocery store when another car backed into my driver-side door. The other driver left a note with their insurance details.';
    }
    form.requestSubmit();
    return label;
  });
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ctxA = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 1 });
const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const A = await ctxA.newPage(); watch(A, 'claimant');
const B = await ctxB.newPage(); watch(B, 'adjuster');
let claimNumber = '';
try {
  // Beat 1: the policyholder reports the loss on a phone.
  await signIn(A, claimant);
  step(`claimant signed in: ${claimant.displayName} (${claimant.hint?.policyNumber})`);
  await shot(A, 'claimant-welcome');
  await A.getByRole('button', { name: /start my claim/i }).click();
  await A.waitForSelector('input[name="lossType"]');
  await A.check('input[name="lossType"][value="collision"]');
  await A.check('input[name="mode"][value="guided"]').catch(() => {});
  await shot(A, 'claimant-start');
  await A.click('main form button[type="submit"]');
  await A.waitForSelector('#holder-check');
  await shot(A, 'claimant-holder-check');
  await A.click('#holder-go');
  await A.waitForSelector('input[name="insured_vehicle"]');
  await A.locator('input[name="insured_vehicle"]').first().check();
  await A.waitForSelector('#vehicle-continue:not([disabled])');
  await shot(A, 'claimant-vehicle');
  await A.click('#vehicle-continue');
  for (let i = 0; i < 25; i += 1) {
    await A.waitForSelector('#review-title, main form');
    if (await A.locator('#review-title').count()) break;
    const q = await answer(A);
    await A.waitForFunction((prev) => document.querySelector('#review-title')
      || (document.querySelector('main legend, main form label')?.textContent?.trim() ?? '') !== prev, q, { timeout: 8000 });
  }
  await shot(A, 'claimant-review');
  await A.click('#submit-claim');
  await A.waitForSelector('#claim-number');
  claimNumber = (await A.textContent('#claim-number')).trim();
  const claimId = new URL(A.url()).searchParams.get('claim');
  await shot(A, 'claimant-confirmation');
  step(`claim reported: ${claimNumber} (${claimId})`);

  // Beat 2: the adjuster opens it, reads the AI summary and timers, and asks for photos.
  await signIn(B, adjuster);
  await B.goto(`${base}/adjuster#/claim/${claimId}`);
  await B.waitForSelector('#panel-header');
  await B.waitForSelector('form.request-form');
  await shot(B, 'adjuster-claim');
  const status = await B.locator('#panel-header').textContent();
  step(`adjuster ${adjuster.displayName} opened the claim (${status.match(/Assigned|Fast tracked|In review|Reported|Triaged/)?.[0] ?? 'status?'})`);
  await B.selectOption('form.request-form select[name="kind"]', 'photos');
  await B.fill('form.request-form [name="message"]', 'Please add two photos of the driver-side door and one of the other driver’s note.');
  await B.locator('form.request-form button[type="submit"]').click();
  await B.waitForFunction(() => /pending info/i.test(document.querySelector('#panel-header')?.textContent ?? ''), null, { timeout: 10000 });
  await shot(B, 'adjuster-requested');
  step('adjuster requested photos; claim is Pending info');

  // Beat 3: the policyholder sees the request on the status page and replies with a photo.
  await A.click('#status-note ~ .cl-actions button').catch(() => {});
  await A.waitForSelector('#messages-list li', { timeout: 20000 });
  await shot(A, 'claimant-message');
  await A.selectOption('#ev-kind', 'photo').catch(() => {});
  await A.setInputFiles('#ev-files', { name: 'driver-door.png', mimeType: 'image/png', buffer: png });
  await A.waitForSelector('#ev-received li', { timeout: 15000 });
  await shot(A, 'claimant-uploaded');
  step('claimant read the message and uploaded driver-door.png');

  // Beat 4: the adjuster sees the photo arrive and resumes the review.
  await B.reload();
  await B.waitForSelector('#panel-header');
  await B.waitForFunction(() => /driver-door/i.test(document.body.innerText), null, { timeout: 15000 });
  await B.locator('[data-status-to="in_review"]').first().click();
  await B.waitForFunction(() => /in review/i.test(document.querySelector('#panel-header')?.textContent ?? ''), null, { timeout: 10000 });
  await shot(B, 'adjuster-resumed');
  step('adjuster sees the photo and moved the claim back to In review');

  // Beat 5: the policyholder's tracker moves on without a call.
  await A.click('#status-note ~ .cl-actions button').catch(() => {});
  await A.waitForTimeout(1500);
  await shot(A, 'claimant-tracker');
} catch (e) {
  problems.push(`journey stopped: ${String(e.message).split('\n')[0]}`);
  await shot(A, 'claimant-failure').catch(() => {});
  await shot(B, 'adjuster-failure').catch(() => {});
}
await browser.close();
console.log(problems.length ? `PROBLEMS\n  ${problems.join('\n  ')}` : `journey ok: ${claimNumber}, ${n} screenshots in ${out}`);
process.exitCode = problems.length ? 1 : 0;
