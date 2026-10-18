import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, fieldHtml, panelHtml, summaryHtml, tabsHtml, TABS } from '../../../../src/web/admin/render.js';
import { normalizeReport } from '../../../../src/web/admin/config-model.js';

const cfg = () => ({
  tenantId: 'demo', version: 3, displayName: 'Demo <b>', locales: ['en', 'es'], branding: { primaryColor: '#0b5cad' },
  lobs: [{ id: 'a', enabled: true, label: { en: 'A', es: 'Aa' } }],
  questionSets: [{ id: 'qs', lob: 'a', version: 1, questions: [{ id: 'q1', text: 'One', type: 'select', showIf: { fact: 'loss.cause', op: 'eq', value: 'glass' } }] }],
  rules: [{ id: 'RT-X-01', stage: 'routing', when: true, then: [{ type: 'add_flag', flag: 'x' }] }],
  timers: [{ id: 't1', state: 'WI', kind: 'acknowledge', duration: { value: 1, unit: 'days' } }],
  fastTrack: { enabled: true, maxSeverity: 30 },
});
const ctx = (over = {}) => ({ cfg: cfg(), version: 3, report: null, localErrors: {}, rawText: {}, qSet: 0, ...over });

test('esc neutralises markup', () => {
  assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('fieldHtml wires label, data attributes and error description', () => {
  const html = fieldHtml({ pointer: '/branding/primaryColor', label: 'Primary color', value: 'red', errors: [{ message: 'bad "colour"' }], hint: 'Hex.' });
  assert.match(html, /<label for="f-branding-primaryColor">Primary color<\/label>/);
  assert.match(html, /data-path="\/branding\/primaryColor"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="f-branding-primaryColor-hint f-branding-primaryColor-err"/);
  assert.match(html, /data-error-for="\/branding\/primaryColor">bad &quot;colour&quot;/);
});

test('every tab renders with its heading and no raw markup from config values', () => {
  for (const [id] of TABS) {
    const html = panelHtml(id, ctx({ history: { available: false, rows: [] }, kpis: { available: false }, webhooks: { available: true, items: [] } }));
    assert.match(html, new RegExp(`id="h-${id}"`), id);
  }
  assert.ok(!panelHtml('branding', ctx()).includes('Demo <b>'));
});

test('questions panel shows showIf JSON, a readable summary and locale inputs', () => {
  const html = panelHtml('questions', ctx());
  assert.match(html, /data-path="\/questionSets\/0\/questions\/0\/showIf"/);
  assert.match(html, /Reads as: loss\.cause eq &quot;glass&quot;/);
  assert.match(html, /data-locale="es"/);
  assert.match(html, /data-path="\/questionSets\/0\/questions\/0\/options"/, 'select type shows options');
});

test('rules panel shows when and then editors and the fast track limits', () => {
  const html = panelHtml('rules', ctx());
  assert.match(html, /data-path="\/rules\/0\/when"/);
  assert.match(html, /data-path="\/rules\/0\/then"/);
  assert.match(html, /data-path="\/fastTrack\/maxSeverity"/);
});

test('validation errors render inline next to their fields, including JSON children', () => {
  const report = normalizeReport({ valid: false, errors: [{ path: '/rules/0/when/fact', code: 'x', message: 'Unknown fact' }, { path: '/timers/0/duration/value', message: 'must be >= 1' }] });
  assert.match(panelHtml('rules', ctx({ report })), /data-error-for="\/rules\/0\/when">Unknown fact/);
  assert.match(panelHtml('timers', ctx({ report })), /data-error-for="\/timers\/0\/duration\/value">must be &gt;= 1/);
});

test('local JSON errors keep the user text', () => {
  const html = panelHtml('rules', ctx({ localErrors: { '/rules/0/when': 'Invalid JSON: x' }, rawText: { '/rules/0/when': '{oops' } }));
  assert.match(html, />\{oops<\/textarea>/);
  assert.match(html, /Invalid JSON: x/);
});

test('history and kpi panels show 404 fallbacks', () => {
  assert.match(panelHtml('history', ctx({ history: { available: false, rows: [] } })), /id="history-fallback"/);
  assert.match(panelHtml('kpis', ctx({ kpis: { available: false } })), /id="kpi-fallback"/);
  const h = panelHtml('history', ctx({ history: { available: true, rows: [{ version: 3, actor: 'ann', at: 't', changed: ['rules'] }] } }));
  assert.match(h, /data-version="3"/);
  const k = panelHtml('kpis', ctx({ kpis: { available: true, body: { metrics: { stp: { value: 0.4 } } } } }));
  assert.match(k, /metrics\.stp\.value/);
});

test('tabs show error counts and summary lists problems with goto links', () => {
  const report = normalizeReport({ valid: false, errors: [{ path: '/branding/primaryColor', message: 'bad' }] });
  assert.match(tabsHtml('branding', report), /aria-label="1 problems"/);
  const s = summaryHtml(report);
  assert.match(s, /role="alert"/);
  assert.match(s, /data-goto="\/branding\/primaryColor" data-section="branding"/);
  assert.match(summaryHtml({ valid: true, errors: [], warnings: [] }), /Configuration is valid/);
  assert.equal(summaryHtml(null), '');
});

test('webhooks panel lists subscriptions and handles an absent service', () => {
  const ok = panelHtml('webhooks', ctx({ webhooks: { available: true, items: [{ id: 'w1', url: 'https://example.test/h', eventTypes: ['claim.created'], active: true }] } }));
  assert.match(ok, /data-webhook="w1"/);
  assert.match(ok, /data-act="wh-toggle"/);
  assert.match(panelHtml('webhooks', ctx({ webhooks: { available: false, items: [] } })), /not available/);
});
