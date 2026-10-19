// Playwright test for the exported PMO dashboard snapshot (S6-PMO-02): opens the file offline, clicks every tab,
// asserts no console errors, no network requests and no error state, and writes the reviewer screenshots.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENS = path.join(ROOT, 'docs', 'design', 'screens');
const FILE = path.join(ROOT, 'dashboard', 'snapshot.html');
let browser; let skip;

before(async () => {
  const require = createRequire(import.meta.url);
  let pw = null;
  for (const c of ['playwright', '/opt/node-tools/node_modules/playwright']) { try { pw = require(c); break; } catch { /* next */ } }
  if (!pw?.chromium) { skip = 'playwright is not installed'; return; }
  try { browser = await pw.chromium.launch({ headless: true }); } catch (e) { skip = `chromium could not launch: ${String(e.message).split('\n')[0]}`; return; }
  const { exportSnapshot } = await import('../../dashboard/export.mjs');
  exportSnapshot();
});
after(async () => { await browser?.close(); });

async function open({ width = 1440, height = 900, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion: 'reduce' });
  await context.route(/^(?!file:|data:|blob:)/, (r) => { context.requests.push(r.request().url()); r.abort(); });
  context.requests = [];
  const page = await context.newPage();
  page.errors = [];
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(pathToFileURL(FILE).href);
  await page.waitForSelector('#tabs button');
  return { page, context };
}
const shot = async (page, name) => { fs.mkdirSync(SCREENS, { recursive: true }); await page.screenshot({ path: path.join(SCREENS, name) }); };

test('snapshot is under 2 MB', () => { assert.ok(fs.statSync(FILE).size < 2 * 1024 * 1024); });

test('every tab renders offline without errors', async (t) => {
  if (skip) return t.skip(skip);
  const { page, context } = await open();
  const n = await page.locator('#tabs button').count();
  assert.ok(n >= 12);
  for (let i = 0; i < n; i++) {
    await page.locator('#tabs button').nth(i).click();
    const text = await page.locator('#view').innerText();
    assert.doesNotMatch(text, /Try again|Render error|Cannot load/i, `tab ${i}`);
    assert.ok(text.length > 0);
    if (i === 0) await shot(page, 'dashboard-overview.png');
  }
  assert.deepEqual(page.errors, []);
  assert.deepEqual(context.requests, []);
  await context.close();
});

test('decision network tab: graph, filters, keyboard, themes, 390 px', async (t) => {
  if (skip) return t.skip(skip);
  const { page, context } = await open();
  await page.getByRole('tab', { name: 'Decision network' }).click();
  assert.ok(await page.locator('svg.netsvg circle').count() > 10);
  assert.ok(await page.locator('.netsvg line').count() > 10);
  assert.ok(await page.locator('.netleg').innerText().then((x) => /message/.test(x) && /agent run/.test(x)));
  const before = await page.locator('.netsvg line').count();
  await page.locator('[data-nk=msg]').uncheck();
  assert.ok(await page.locator('.netsvg line').count() < before);
  await page.locator('[data-nk=msg]').check();
  await page.selectOption('#netteam', 'pmo');
  assert.ok(await page.locator('.nn.dim').count() > 0);
  await page.selectOption('#netteam', '');
  await page.getByRole('tab', { name: 'Decision network' }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tabs [aria-selected=true]').innerText(), 'Sprint board');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#tabs [aria-selected=true]').innerText(), 'Decision network');
  await shot(page, 'dashboard-network.png');
  await context.close();
  for (const [w, h, cs] of [[1440, 900, 'dark'], [390, 844, 'light']]) {
    const c = await open({ width: w, height: h, colorScheme: cs });
    await c.page.getByRole('tab', { name: 'Decision network' }).click();
    assert.ok(await c.page.locator('.netsvg circle').count() > 10);
    assert.ok(await c.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no horizontal scroll at ${w}`);
    assert.deepEqual(c.page.errors, []);
    await c.context.close();
  }
});
