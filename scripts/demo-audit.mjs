// Demo audit: drives every demo persona and key flow in Chromium and reports console errors, failed API calls,
// raw or empty values. Start the app first (FNOL_DEV_MODE=1 PORT=<port> FNOL_DB_PATH=<tmp db> node scripts/dev.mjs), then:
//   node scripts/demo-audit.mjs <out dir> http://localhost:<port>
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const base = process.argv[3] ?? 'http://localhost:18400', out = process.argv[2] ?? 'audit-out'; fs.mkdirSync(out, { recursive: true });
const personas = await (await fetch(base + '/api/v1/dev/personas')).json();
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const report = [];
const BAD = /\bundefined\b|\bNaN\b|Invalid Date|\[object Object\]|\bnull\b/;
async function audit(name, fn) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const issues = [];
  p.on('console', (m) => { if (m.type() === 'error') issues.push('console: ' + m.text().slice(0, 200)); });
  p.on('pageerror', (e) => issues.push('pageerror: ' + String(e.message).slice(0, 200)));
  p.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) issues.push(`http ${r.status()} ${r.request().method()} ${r.url().replace(base, '')}`); });
  try { await fn(p, issues); } catch (e) { issues.push('step failed: ' + String(e.message).split('\n')[0].slice(0, 200)); }
  try {
    const txt = await p.locator('body').innerText();
    const bad = txt.split('\n').filter((l) => BAD.test(l)).slice(0, 5);
    if (bad.length) issues.push('bad text: ' + bad.join(' | ').slice(0, 300));
    const dashes = (txt.match(/^\s*—\s*$/gm) || []).length; if (dashes > 3) issues.push(`empty fields shown as dash: ${dashes}`);
    await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  } catch {}
  report.push({ name, issues });
  await ctx.close();
}
async function as(p, tenantId, personaId) {
  await p.goto(base + '/');
  await p.waitForSelector('#fxd-tenant:not([disabled])', { timeout: 15000 });
  await p.selectOption('#fxd-tenant', tenantId);
  await p.waitForTimeout(800);
  await Promise.all([p.waitForLoadState('load').catch(() => {}), p.selectOption('#fxd-persona', personaId)]);
  await p.waitForTimeout(3000);
}
for (const t of personas.tenants) {
  for (const per of t.personas) {
    await audit(`${t.id}--${per.role}-landing`, async (p) => { await as(p, t.id, per.id); });
  }
  const csr = t.personas.find((x) => x.role === 'csr');
  await audit(`${t.id}--csr-search-select`, async (p, issues) => {
    await as(p, t.id, csr.id);
    const box = p.locator('input[type=search], #search input, input').first();
    await box.fill('A'); await p.waitForTimeout(1500);
    const rows = p.locator('table tbody tr');
    issues.push(`info: search rows ${await rows.count()}`);
    await rows.first().click(); await p.keyboard.press('Enter'); await p.waitForTimeout(3000);
  });
  const adj = t.personas.find((x) => x.role === 'adjuster');
  await audit(`${t.id}--adjuster-claim`, async (p, issues) => {
    await as(p, t.id, adj.id);
    const link = p.locator('a[href*="claim"], table tbody tr a').first();
    issues.push(`info: inbox links ${await p.locator('table tbody tr').count()}`);
    await link.click(); await p.waitForTimeout(3000);
  });
  const cl = t.personas.find((x) => x.role === 'claimant');
  await audit(`${t.id}--claimant-start`, async (p, issues) => {
    await as(p, t.id, cl.id);
    const btn = p.getByRole('button', { name: /start|begin|report/i }).first();
    if (await btn.count()) { await btn.click(); await p.waitForTimeout(2500); }
    issues.push('info: hint ' + JSON.stringify(cl.hint));
  });
  const ad = t.personas.find((x) => x.role === 'carrier_admin');
  await audit(`${t.id}--admin-sections`, async (p, issues) => {
    await as(p, t.id, ad.id);
    const navs = p.locator('nav a, nav button, [role=tab]');
    const n = await navs.count(); issues.push('info: admin nav items ' + n);
    for (let i = 0; i < Math.min(n, 10); i++) { await navs.nth(i).click().catch(() => {}); await p.waitForTimeout(600); }
  });
}
await b.close();
fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
for (const r of report) console.log(`${r.name}: ${r.issues.length ? '\n   ' + r.issues.join('\n   ') : 'ok'}`);
