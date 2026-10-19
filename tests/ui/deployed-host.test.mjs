// Deployed-host smoke: apps opened under a non-localhost hostname must work (runtime-config) and must not send Authorization.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let pw; let browser; let skip; const servers = [];

async function boot(devMode) {
  const { createApp } = await import('../../src/server.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-deployed-'));
  const app = await createApp({
    dbPath: path.join(dir, 'd.db'), port: 0, secretsDir: path.join(dir, 'secrets'),
    tenantsDir: path.join(ROOT, 'tenants'), logLevel: 'silent', devMode,
  });
  servers.push({ app, dir });
  return app;
}

before(async () => {
  const require = createRequire(import.meta.url);
  for (const c of ['playwright', '/opt/node-tools/node_modules/playwright']) {
    try { pw = require(c); break; } catch { /* next */ }
  }
  if (!pw?.chromium) { skip = 'playwright is not installed'; return; }
  try {
    browser = await pw.chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP fnol.test 127.0.0.1'] });
  } catch (e) { skip = `chromium could not launch: ${String(e.message).split('\n')[0]}`; }
});
after(async () => {
  await browser?.close();
  for (const { app, dir } of servers) { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

function track(page) {
  page.authHeaders = []; page.apiCalls = [];
  page.on('request', (r) => {
    const h = r.headers();
    if (h.authorization) page.authHeaders.push(r.url());
    if (r.url().includes('/api/v1/')) page.apiCalls.push(r.url());
  });
}

test('claimant reaches the first intake question on a non-localhost host, no Authorization header', async (t) => {
  if (skip) return t.skip(skip);
  const app = await boot(true);
  const page = await browser.newPage();
  track(page);
  try {
    await page.goto(`http://fnol.test:${app.port}/claimant`);
    await page.waitForSelector('input[name="lob"]');
    await page.check('input[name="lob"][value="personal_auto"]');
    await page.check('input[name="mode"][value="guided"]');
    await page.click('form button[type="submit"]');
    await page.waitForSelector('main form fieldset, main form input, main form select, main form textarea');
    await page.waitForFunction(() => !document.querySelector('input[name="lob"]'));
    assert.ok(page.apiCalls.length > 0);
    assert.deepEqual(page.authHeaders, []);
  } finally { await page.close(); }
});

test('with devMode false dev login is unavailable on a non-localhost host', async (t) => {
  if (skip) return t.skip(skip);
  const app = await boot(false);
  const page = await browser.newPage();
  track(page);
  try {
    await page.goto(`http://fnol.test:${app.port}/claimant`);
    await page.waitForSelector('#view-title');
    assert.equal(await page.locator('input[name="lob"]').count(), 0);
    assert.equal(await page.evaluate(() => window.__FNOL_DEV__), false);
    assert.deepEqual(page.authHeaders, []);
  } finally { await page.close(); }
});
