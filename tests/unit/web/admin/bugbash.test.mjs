// S6-BUG-04 bug bash regressions for the carrier admin console (pure modules, no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as m from '../../../../src/web/admin/config-model.js';
import { applyListAction } from '../../../../src/web/admin/edit.js';
import { READ_ONLY_TABS, diffHtml, panelHtml, summaryHtml } from '../../../../src/web/admin/render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const tenant = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'tenants', `${id}.json`), 'utf8'));
const ctxOf = (cfg, over = {}) => ({ cfg, version: 1, report: null, localErrors: {}, rawText: {}, qSet: 0, webhooks: { available: true, items: [] }, ...over });
const ask = (set) => m.runSequence(set.questions, { key: 'order', missing: 1e6, tie: 'index' }).map((i) => set.questions[i].id);

test('ADMIN-3: moving a question down changes the order claimants are asked in, and the diff is one readable row', () => {
  const saved = tenant('kestrel-point');
  const si = saved.questionSets.findIndex((s) => s.id === 'commauto-general');
  const st = { cfg: m.clone(saved), qSet: si };
  const first = ask(saved.questionSets[si]).slice(0, 2);
  assert.deepEqual(first, ['loss_date', 'loss_time']);
  applyListAction(st, 'down', `/questionSets/${si}/questions`, 0);
  assert.deepEqual(ask(st.cfg.questionSets[si]).slice(0, 2), ['loss_time', 'loss_date'], 'intake sorts by order, so the order value moved');
  const changes = m.diffConfig(saved, st.cfg);
  assert.equal(changes.length, 1, JSON.stringify(changes));
  assert.equal(changes[0].kind, 'moved');
  assert.equal(m.describeChange(changes[0]), 'loss_date moved after loss_time');
  const html = diffHtml(changes);
  const visible = html.replace(/<[^>]*>/g, ' ');
  assert.doesNotMatch(visible, /\(removed\)|mapsTo|\/questionSets\//, 'no field-by-field swaps on raw pointers');
});

test('ADMIN-3: unsorted sets and rule priorities move in run order; rules stay inside their stage', () => {
  const saved = tenant('aurelia-mutual');
  const hi = saved.questionSets.findIndex((s) => s.id === 'home-general');
  const st = { cfg: m.clone(saved) };
  const before = ask(saved.questionSets[hi]);
  const k = before.indexOf('loss_cause');
  const idx = saved.questionSets[hi].questions.findIndex((q) => q.id === 'loss_cause');
  applyListAction(st, 'down', `/questionSets/${hi}/questions`, idx);
  const after = ask(st.cfg.questionSets[hi]);
  assert.equal(after.indexOf('loss_cause'), k + 1);
  const seq = m.runSequence(saved.rules, m.orderedListSpec('/rules'));
  const glass = seq.findIndex((i) => saved.rules[i].id === 'RT-FT-GLASS');
  const rs = { cfg: m.clone(saved) };
  applyListAction(rs, 'down', '/rules', seq[glass]);
  const seq2 = m.runSequence(rs.cfg.rules, m.orderedListSpec('/rules')).map((i) => rs.cfg.rules[i].id);
  assert.equal(seq2.indexOf('RT-FT-GLASS'), glass + 1);
  const intake = seq[0];
  assert.equal(m.moveInRunOrder(m.clone(saved), '/rules', intake, 1), false, 'the only intake rule cannot move into triage');
});

test('ADMIN-7: diff rows are labelled by field name and new items are summarised', () => {
  const a = tenant('kestrel-point');
  const b = m.clone(a);
  b.displayName = 'Kestrel Point Test'; b.branding.primaryColor = '#123456';
  b.questionSets[2].questions.push(m.newQuestion('question_18'));
  const rows = m.diffConfig(a, b);
  const labels = rows.map((r) => r.label);
  assert.ok(labels.includes('Branding > Primary color'));
  assert.ok(labels.includes('Identity > Display name'));
  const html = diffHtml(rows);
  assert.doesNotMatch(html, /fx-mono">\//, 'no monospace pointer labels');
  assert.match(html, /question_18 \(no text yet\)/);
  assert.doesNotMatch(html, /\{&quot;id&quot;/, 'no raw JSON object as the after-value');
});

test('ADMIN-6: schema messages become plain language with field labels', () => {
  const cfg = tenant('aurelia-mutual');
  const r = m.normalizeReport({ valid: false, errors: [
    { path: '/claimNumberPrefix', code: 'pattern', message: 'must match ^[A-Z]{2,5}$' },
    { path: '/branding/primaryColor', code: 'pattern', message: 'must match ^#[0-9a-fA-F]{6}$' },
  ] }, cfg);
  assert.deepEqual(r.errors.map((e) => e.message), ['Use 2 to 5 capital letters, for example AUR.', 'Enter a six-digit hex colour such as #0b5cad.']);
  const html = summaryHtml(r);
  assert.match(html, />Identity &gt; Claim number prefix<\/a>/);
  assert.match(html, />Branding &gt; Primary color<\/a>/);
  assert.doesNotMatch(html, /\^\[|>\/branding/, 'no regex or pointer text');
  assert.match(panelHtml('branding', ctxOf(cfg, { report: r })), /data-error-for="\/claimNumberPrefix">Use 2 to 5 capital letters/);
});

test('ADMIN-8: warnings are listed with message and a link to the field', () => {
  const cfg = tenant('kestrel-point');
  const r = m.normalizeReport({ valid: true, errors: [], warnings: [{ path: '/timers/6/citation', message: 'timer "timer_7" is not labelled illustrative; demo deadlines must say "Illustrative, not legal advice"' }] }, cfg);
  const html = summaryHtml(r);
  assert.match(html, /with 1 warning/);
  assert.match(html, /data-goto="\/timers\/6\/citation" data-section="timers"/);
  assert.match(html, /is not labelled illustrative/);
});

test('ADMIN-4: queues, severity bands, holidays, notifications, ports, security and timer details have controls', () => {
  const cfg = tenant('kestrel-point');
  const c = ctxOf(cfg);
  const has = (tab, p) => assert.match(panelHtml(tab, c), new RegExp(`data-path="${p.replace(/\//g, '\\/')}"`), `${tab} ${p}`);
  for (const p of ['/queues/0/id', '/queues/0/adjusters', '/queues/0/slaHours', '/queues/0/assignment', '/defaultQueue', '/severityBands/major']) has('rules', p);
  for (const p of ['/holidays', '/timers/0/citation', '/timers/0/stopOn/taskType', '/timers/0/warnBefore/value', '/timers/0/onBreach']) has('timers', p);
  for (const p of ['/notifications/claimant/channels', '/notifications/internal/emails', '/integrations/policyPort/adapter', '/integrations/claimsPort/pushOn', '/integrations/claimsPort/settings']) has('webhooks', p);
  for (const p of ['/security/sessionTtlMinutes', '/security/dataRetentionDays', '/security/piiKeyRef']) has('security', p);
  assert.match(panelHtml('rules', c), /adj-kpt-101, adj-kpt-102/, 'adjusters are visible');
  const st = { cfg: m.clone(cfg) };
  applyListAction(st, 'add', '/queues');
  assert.equal(st.cfg.queues.at(-1).id, `queue_${cfg.queues.length + 1}`);
});

test('ADMIN-9: a new question has no placeholder text or type, so it cannot pass as-is', () => {
  const st = { cfg: tenant('aurelia-mutual') };
  applyListAction(st, 'add', '/questionSets/0/questions');
  const q = st.cfg.questionSets[0].questions.at(-1);
  assert.equal(q.text, '');
  assert.equal(q.type, '');
  assert.ok(q.order < 99, 'asked before the closing disclosure');
});

test('ADMIN-10: dropdowns, set picker and line headings show readable labels', () => {
  const cfg = tenant('kestrel-point');
  const ai = panelHtml('ai', ctxOf(cfg));
  assert.match(ai, /<option value="cascade" selected>Provider cascade/);
  const rules = panelHtml('rules', ctxOf(cfg));
  assert.match(rules, /<option value="post_routing">Post-routing<\/option>/);
  const timers = panelHtml('timers', ctxOf(cfg));
  assert.match(timers, /<option value="business_days"[^>]*>Business days<\/option>/);
  const q = panelHtml('questions', ctxOf(cfg, { qSet: 0 }));
  assert.match(q, />Auto, general \(Personal auto\)<\/option>/);
  assert.match(q, />Commercial auto, general \(Commercial auto\)<\/option>/);
  assert.match(q, /<option value="personal_auto" selected>Personal auto<\/option>/);
  assert.match(q, /<strong>Personal auto<\/strong>/);
  assert.doesNotMatch(q, />personal_auto<\/(option|strong)>/);
});

test('ADMIN-11: KPI tiles carry no value-driver codes', () => {
  const html = panelHtml('kpis', ctxOf(tenant('kestrel-point'), { kpis: { available: true, body: { metrics: [{ id: 'stp', label: 'STP', valueDriver: 'VD-1', unit: 'ratio', value: 0.1, numerator: 1, denominator: 14 }] } } }));
  assert.doesNotMatch(html, /VD-\d/);
  assert.match(html, /hint="1 of 14 claims"/);
});

test('ADMIN-14: the webhook secret stays in a panel with a copy control', () => {
  const html = panelHtml('webhooks', ctxOf(tenant('aurelia-mutual'), { newSecret: { url: 'https://hooks.aurelia-mutual.example/fnol', secret: 'whsec_demo123' } }));
  assert.match(html, /id="wh-secret"/);
  assert.match(html, /whsec_demo123/);
  assert.match(html, /data-act="wh-copy"/);
  assert.match(html, /data-act="wh-secret-done"/);
  assert.doesNotMatch(panelHtml('webhooks', ctxOf(tenant('aurelia-mutual'))), /id="wh-secret"/);
});

test('ADMIN-18: a blank threshold shows the inherited value', () => {
  const k = tenant('kestrel-point');
  const html = panelHtml('ai', ctxOf(k));
  assert.match(html, /placeholder="0\.85 \(inherited\)"/, 'Kestrel summarize uses the local cascade minimum 0.85');
  assert.match(html, /Blank: uses the local provider minimum in the cascade \(0\.85\)/);
  assert.deepEqual(m.inheritedThreshold(tenant('aurelia-mutual').ai, 'summarize').value, 0.75);
  assert.equal(m.inheritedThreshold({ provider: 'local' }, 'summarize').value, 0.7);
});

test('ADMIN-2 and ADMIN-19: history names the saver and read-only tabs are declared', () => {
  const cfg = { ...tenant('aurelia-mutual'), updatedBy: 'dev-aurelia-mutual-carrier-admin' };
  const html = panelHtml('history', ctxOf(cfg, { version: 2, history: { available: true, rows: m.normalizeHistory({ items: [
    { version: 2, actor: 'dev-aurelia-mutual-carrier-admin', actorName: 'Taylor Brandt', createdAt: '2026-10-01T10:00:00Z', changedKeys: ['branding', 'displayName'] },
    { version: 1, actor: 'boot', createdAt: '2026-09-01T10:00:00Z', changedKeys: [], source: 'tenant_file' },
  ] }) } }));
  assert.match(html, /last saved by Taylor Brandt/);
  assert.match(html, /<td>Taylor Brandt<\/td>/);
  assert.match(html, /Branding, Identity/);
  assert.match(html, /data-version="1"/);
  assert.doesNotMatch(html, /dev-aurelia-mutual-carrier-admin|branding, other/);
  assert.deepEqual(READ_ONLY_TABS, ['kpis', 'history']);
});
