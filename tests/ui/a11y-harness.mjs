// Harness for the claimant and CSR UI smoke tests plus a11y reporting (own copy; imports no other team's harness).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checkDocument, reportWarnings } from '../../src/web/shared/a11y-check.js';
import { generatePolicies } from '../synthetic/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

/** Load Playwright (normal resolution, then /opt/node-tools) and launch chromium, or return {skip}. Never throws. */
export async function launchBrowser() {
  const require = createRequire(import.meta.url);
  let pw = null;
  for (const c of ['playwright', '/opt/node-tools/node_modules/playwright']) {
    try { pw = require(c); break; } catch { /* try the next location */ }
  }
  if (!pw?.chromium) return { skip: 'playwright is not installed' };
  try {
    return { browser: await pw.chromium.launch({ headless: true }) };
  } catch (err) {
    return { skip: `chromium could not launch: ${String(err.message).split('\n')[0]}` };
  }
}

/**
 * Boot the real app on port 0 (temp db, temp secrets, real tenants) and seed synthetic policies for each tenant.
 * @returns {Promise<{ app: any, close: () => Promise<void>, policies: Record<string, any[]> }>}
 */
export async function bootApp({ tenants = ['aurelia-mutual', 'kestrel-point'] } = {}) {
  const { createApp } = await import('../../src/server.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-a11yui-'));
  let app;
  try {
    app = await createApp({
      dbPath: path.join(dir, 'ui.db'), port: 0, secretsDir: path.join(dir, 'secrets'),
      tenantsDir: path.join(ROOT, 'tenants'), logLevel: 'silent', devMode: true,
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const policies = {};
  for (const tenantId of tenants) {
    policies[tenantId] = generatePolicies({ tenantId, lob: 'personal_auto', count: 3, seed: 7, state: 'WI' });
    await app.ctx.forTenant(tenantId).modules.coverage.seedPolicies(policies[tenantId]);
  }
  return {
    app, policies,
    async close() {
      try { await app.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  };
}

/** Run checkDocument inside the page (its source is shipped with page.evaluate) and report warnings only. */
export async function reportPageA11y(page, label, t) {
  let findings = [];
  try {
    findings = await page.evaluate(`(${checkDocument.toString()})(document)`);
  } catch (err) {
    findings = [{ rule: 'a11y-run', severity: 'warning', target: label, message: `a11y scan could not run: ${err.message}` }];
  }
  return { findings, lines: reportWarnings(findings, { label: `a11y ${label}`, diagnostic: (m) => t?.diagnostic?.(m) }) };
}

/** The only claim-number shape we assert on: letters/digits with dashes, at least 6 characters. */
export const CLAIM_NUMBER = /^[A-Z0-9][A-Z0-9-]{5,}$/;

/**
 * Answer whatever question is on screen in the claimant guided flow with synthetic data.
 * Returns the question label answered, or null when no question form is showing.
 */
export async function answerClaimantQuestion(page, policy) {
  return page.evaluate((p) => {
    const form = document.querySelector('main form');
    if (!form) return null;
    const fs = form.querySelector('fieldset');
    const label = (fs?.querySelector('legend') ?? form.querySelector('label'))?.textContent?.trim() ?? '';
    const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
    if (fs) {
      const boxes = [...fs.querySelectorAll('input')];
      const noPref = boxes.find((i) => i.value === 'false');
      const pick = boxes[0].type === 'checkbox' ? boxes[0] : (noPref ?? boxes[0]);
      pick.checked = true; fire(pick, 'change');
    } else {
      const c = form.querySelector('input,select,textarea');
      if (c.tagName === 'SELECT') c.value = [...c.options].find((o) => o.value)?.value ?? '';
      else if (c.type === 'date') c.value = '2026-09-10';
      else if (c.type === 'number') c.value = '250';
      else if (c.type === 'tel') c.value = '(555) 010-0155';
      else if (c.type === 'email') c.value = 'synthetic.claimant@example.test';
      else c.value = 'Synthetic test claim: a stone cracked the windshield on the highway.';
    }
    form.requestSubmit();
    return label;
  }, policy);
}

/**
 * Answer the question showing in the CSR assisted-intake panel (fx-field) with synthetic data.
 * Returns the label answered, or null when no field is showing.
 */
export async function answerCsrQuestion(page) {
  const label = await page.evaluate(() => {
    const f = document.querySelector('#answer-slot fx-field');
    if (!f) return null;
    const c = f.querySelector('input,select,textarea');
    if (c.tagName === 'SELECT') c.value = [...c.options].find((o) => o.value === 'false')?.value ?? [...c.options].find((o) => o.value)?.value ?? '';
    else if (c.type === 'date') c.value = '2026-09-10';
    else if (c.type === 'number') c.value = '250';
    else if (c.type === 'tel') c.value = '(555) 010-0155';
    else c.value = 'Synthetic test claim: rear-end collision at a stop light.';
    return f.getAttribute('label');
  });
  if (label === null) return null;
  await page.click('#answer-go');
  return label;
}
