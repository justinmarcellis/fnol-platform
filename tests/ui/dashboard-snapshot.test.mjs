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
  assert.ok(n >= 13);
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

const pulses = (page) => page.locator('#netcanvas').evaluate((c) => Number(c.dataset.pulses));

test('decision network tab: canvas, replay, scrubber, filters, keyboard, themes, 390 px', async (t) => {
  if (skip) return t.skip(skip);
  const { page, context } = await open();
  await page.getByRole('tab', { name: 'Decision network' }).click();
  const cv = page.locator('#netcanvas');
  assert.ok(Number(await cv.getAttribute('data-nodes')) > 10);
  await page.waitForFunction(() => Number(document.getElementById('netcanvas').dataset.edges) > 10);
  assert.ok(await page.locator('.netleg').innerText().then((x) => /message/.test(x) && /agent run/.test(x)));
  // Replay from the start: the cursor moves, edges grow and pulses travel along recorded edges.
  const end = Number(await cv.getAttribute('data-cursor'));
  await page.selectOption('#speed', '10');
  await page.locator('#play').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#follow').isChecked(), false);
  // Wait until the replay is roughly halfway and a pulse is in flight, so the screenshot is mid-replay.
  await page.waitForFunction(() => { const d = document.getElementById('netcanvas').dataset; return Number(d.pulses) > 0 && (d.cursor - d.tmin) / (d.tmax - d.tmin) > 0.45; }, null, { timeout: 15000 });
  const mid = Number(await cv.getAttribute('data-cursor'));
  assert.ok(mid < end, 'replay restarted before the live end');
  await shot(page, 'dashboard-network.png');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'false');
  // Scrubber: keyboard moves the timeline back to the start with no edges lit.
  await page.locator('#scrub').focus();
  await page.keyboard.press('Home');
  await page.waitForFunction(() => { const d = document.getElementById('netcanvas').dataset; return d.cursor === d.tmin; });
  const startCursor = Number(await cv.getAttribute('data-cursor'));
  assert.ok(startCursor < mid);
  assert.equal(startCursor, Number(await cv.getAttribute('data-tmin')));
  // Canvas keyboard stepping.
  await cv.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((c) => Number(document.getElementById('netcanvas').dataset.cursor) > c, startCursor);
  // Filters and follow live.
  await page.locator('#follow').check();
  await page.waitForFunction((e) => Number(document.getElementById('netcanvas').dataset.cursor) >= e, end);
  const edges = Number(await cv.getAttribute('data-edges'));
  for (const k of ['msg', 'ticket', 'review']) await page.locator(`[data-nk=${k}]`).uncheck();
  await page.waitForFunction((n) => Number(document.getElementById('netcanvas').dataset.edges) < n, edges);
  for (const k of ['msg', 'ticket', 'review']) await page.locator(`[data-nk=${k}]`).check();
  await page.selectOption('#netteam', 'pmo');
  await page.selectOption('#netteam', '');
  assert.ok(await page.locator('.feed div').count() > 5);
  await page.getByRole('tab', { name: 'Decision network' }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tabs [aria-selected=true]').innerText(), 'Sprint board');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#tabs [aria-selected=true]').innerText(), 'Decision network');
  assert.deepEqual(page.errors, []);
  await context.close();
  for (const [w, h, cs] of [[1440, 900, 'dark'], [390, 844, 'light']]) {
    const c = await open({ width: w, height: h, colorScheme: cs });
    await c.page.getByRole('tab', { name: 'Decision network' }).click();
    assert.ok(Number(await c.page.locator('#netcanvas').getAttribute('data-nodes')) > 10);
    assert.ok(await c.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no horizontal scroll at ${w}`);
    assert.deepEqual(c.page.errors, []);
    await c.context.close();
  }
});

test('header pill shows the source and the age of the data', async (t) => {
  if (skip) return t.skip(skip);
  const { page, context } = await open();
  const text = await page.locator('#live').innerText();
  assert.match(text, /^snapshot · updated .+/);
  assert.match(await page.locator('#live').getAttribute('class'), /src-snapshot/);
  await context.close();
});

test('sprint board and agent rank tabs render the live documents', async (t) => {
  if (skip) return t.skip(skip);
  const { page, context } = await open();
  await page.getByRole('tab', { name: 'Sprint board' }).click();
  assert.ok(await page.locator('.livecols .tk').count() > 3);
  await page.selectOption('#bsprint', 'all');
  assert.ok(await page.locator('.livecols .tk').count() > 20);
  await page.getByRole('tab', { name: 'Agent rank' }).click();
  assert.ok(await page.locator('#view tbody tr').count() > 5);
  await context.close();
});

test('served locally: the page updates itself within 10 s when org/live data changes', async (t) => {
  if (skip) return t.skip(skip);
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-live-'));
  const { start, metricsDoc } = await import('../../dashboard/server.mjs');
  const { computeFeed } = await import('../../org/live-export.mjs');
  const docs = { ...computeFeed().docs, metrics: metricsDoc() };
  const write = () => { for (const [n, d] of Object.entries(docs)) fs.writeFileSync(path.join(dir, n + '.json'), JSON.stringify(d)); };
  write();
  const server = await start({ port: 0, liveDir: dir });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('#tabs button');
    await page.waitForFunction(() => /^local/.test(document.getElementById('live').textContent), null, { timeout: 10000 });
    await page.getByRole('tab', { name: 'Sprint board' }).click();
    await page.selectOption('#bsprint', 'all');
    const before = await page.locator('.livecols .tk').count();
    // A new story and a fresher metrics document arrive.
    docs.board.tickets.push({ ...docs.board.tickets[0], id: 'S9-LIVE-01', title: 'Story that appeared while watching', status: 'in_progress', sprint: docs.board.tickets[0].sprint });
    docs.board.generatedAt = new Date().toISOString();
    docs.metrics.generatedAt = docs.board.generatedAt;
    write();
    await page.waitForFunction(() => document.body.innerText.includes('Story that appeared while watching'), null, { timeout: 10000 });
    assert.equal(await page.locator('.livecols .tk').count(), before + 1);
    assert.match(await page.locator('#live').innerText(), /^local · updated/);
    assert.deepEqual(page.errors, []);
  } finally { await context.close(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});
