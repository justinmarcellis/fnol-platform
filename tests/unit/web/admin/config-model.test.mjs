import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../../../../src/web/admin/config-model.js';
import { applyFieldEdit, applyListAction } from '../../../../src/web/admin/edit.js';

const cfg = () => ({
  tenantId: 'demo', version: 3, displayName: 'Demo', locales: ['en', 'es'],
  branding: { primaryColor: '#0b5cad' },
  lobs: [{ id: 'a', enabled: true, label: 'A' }, { id: 'b', enabled: false, label: 'B' }],
  questionSets: [{ id: 'qs', lob: 'a', version: 1, questions: [{ id: 'q1', text: 'One', type: 'text' }] }],
  rules: [{ id: 'RT-X-01', stage: 'routing', when: true, then: [{ type: 'add_flag', flag: 'x' }] }],
  timers: [{ id: 't1', state: 'WI', kind: 'acknowledge', duration: { value: 1, unit: 'days' } }],
});

test('pointer helpers read, write, delete and escape', () => {
  const c = cfg();
  assert.equal(m.getAt(c, '/lobs/1/id'), 'b');
  assert.equal(m.getAt(c, '/nope/x'), undefined);
  m.setAt(c, '/branding/accentColor', '#112233');
  assert.equal(c.branding.accentColor, '#112233');
  m.setAt(c, '/branding/accentColor', undefined);
  assert.equal('accentColor' in c.branding, false);
  m.setAt(c, '/x/0/y', 1);
  assert.deepEqual(c.x, [{ y: 1 }]);
  assert.equal(m.toPointer(['a/b', 'c~d', 0]), '/a~1b/c~0d/0');
  assert.deepEqual(m.parsePointer('/a~1b/c~0d'), ['a/b', 'c~d']);
});

test('list edits add, remove and move within bounds', () => {
  const c = cfg();
  assert.equal(m.addItem(c, '/lobs', m.newLob()), 2);
  assert.equal(m.moveItem(c, '/lobs', 0, -1), false);
  assert.equal(m.moveItem(c, '/lobs', 0, 1), true);
  assert.deepEqual(c.lobs.map((l) => l.id), ['b', 'a', 'new_lob']);
  assert.equal(m.removeItem(c, '/lobs', 9), false);
  assert.equal(m.removeItem(c, '/lobs', 2), true);
  assert.equal(c.lobs.length, 2);
});

test('coerce handles numbers, csv, json and bools', () => {
  assert.deepEqual(m.coerce('int', '12'), { value: 12 });
  assert.equal(m.coerce('int', '1.5').error, 'Enter a whole number.');
  assert.equal(m.coerce('number', 'abc').error, 'Enter a number.');
  assert.deepEqual(m.coerce('number', ''), { value: undefined });
  assert.deepEqual(m.coerce('csv', ' WI, MN ,WI'), { value: ['WI', 'MN'] });
  assert.deepEqual(m.coerce('json', '{"a":1}'), { value: { a: 1 } });
  assert.match(m.coerce('json', '{bad').error, /^Invalid JSON/);
  assert.deepEqual(m.coerce('json', '  '), { value: undefined });
  assert.deepEqual(m.coerce('bool', true), { value: true });
});

test('i18n helpers keep plain strings until a second locale appears', () => {
  assert.equal(m.i18nGet('Hello', 'en'), 'Hello');
  assert.equal(m.i18nGet('Hello', 'es'), '');
  const two = m.i18nSet('Hello', 'es', 'Hola');
  assert.deepEqual(two, { en: 'Hello', es: 'Hola' });
  assert.equal(m.i18nSet(two, 'es', ''), 'Hello');
  assert.equal(m.i18nSet({ en: 'x' }, 'en', ''), undefined);
  assert.deepEqual(m.configLocales({ locales: ['en', 'xx!'] }), ['en']);
  assert.deepEqual(m.configLocales({}), ['en']);
});

test('describeCondition renders the condition language', () => {
  assert.equal(m.describeCondition(undefined), 'always');
  assert.equal(m.describeCondition(false), 'never');
  assert.equal(
    m.describeCondition({ all: [{ fact: 'loss.cause', op: 'eq', value: 'glass' }, { not: { fact: 'answers.x', op: 'exists' } }] }),
    '(loss.cause eq "glass" and not answers.x exists)',
  );
  assert.equal(m.describeCondition({ any: [true, { oops: 1 }] }), '(always or invalid condition)');
});

test('normalizeReport maps errors to editor sections', () => {
  const r = m.normalizeReport({
    valid: false,
    errors: [{ path: '/branding/primaryColor', code: 'pattern', message: 'bad' }, { path: '/questionSets/0/questions/0/id', message: 'x' }, { path: '/rules/1/then/0/queue', code: 'unknown_queue', message: 'q' }],
    warnings: [{ path: '/rules', message: 'w' }],
  });
  assert.equal(r.valid, false);
  assert.deepEqual(r.bySection, { branding: 1, questions: 1, rules: 1 });
  assert.equal(m.errorsFor(r, '/branding/primaryColor').length, 1);
  assert.equal(m.errorsUnder(r, '/rules/1').length, 1);
  assert.equal(m.normalizeReport({ valid: true, errors: [] }).valid, true);
  assert.equal(m.normalizeReport(null).valid, false);
  assert.equal(m.sectionOf('/fastTrack/maxSeverity'), 'rules');
  assert.equal(m.sectionOf('/notifications/webhooks'), 'webhooks');
  assert.equal(m.sectionOf('/zzz'), 'other');
});

test('etag, dirty tracking and changed sections', () => {
  assert.equal(m.parseEtag('"7"'), 7);
  assert.equal(m.parseEtag('W/"8"'), 8);
  assert.equal(m.parseEtag('abc'), null);
  assert.equal(m.parseEtag(null), null);
  assert.equal(m.ifMatch(4), '"4"');
  const a = cfg();
  const b = m.clone(a);
  assert.equal(m.isDirty(a, b), false);
  b.version = 9; b.updatedAt = 'now';
  assert.equal(m.isDirty(a, b), false);
  b.rules[0].when = false;
  assert.deepEqual(m.changedSections(a, b), ['rules']);
});

test('normalizeHistory accepts version rows and audit entries and sorts newest first', () => {
  const rows = m.normalizeHistory({ items: [
    { version: 1, actor: 'boot', created_at: 't1' },
    { action: 'tenant.config.updated', actor: 'ann', createdAt: 't3', details: { version: 3, changedSections: ['rules'] } },
    { action: 'claim.created', details: { version: 99 } },
    { version: 2, actor: 'bob', createdAt: 't2' },
    { version: 2, actor: 'dup' },
  ] });
  assert.deepEqual(rows.map((r) => r.version), [3, 2, 1]);
  assert.equal(rows[0].actor, 'ann');
  assert.deepEqual(rows[0].changed, ['rules']);
  assert.deepEqual(m.normalizeHistory(null), []);
});

test('flattenKpis turns nested payloads into rows and nulls into n/a', () => {
  const rows = m.flattenKpis({ period: { from: 'a' }, metrics: { stp: { value: 0.5, note: null } }, list: [1] });
  assert.deepEqual(rows, [
    { key: 'period.from', value: 'a' }, { key: 'metrics.stp.value', value: '0.5' }, { key: 'metrics.stp.note', value: 'n/a' }, { key: 'list[0]', value: '1' },
  ]);
});

test('applyFieldEdit stores valid values, holds invalid JSON aside, and clears when fixed', () => {
  const st = { cfg: cfg() };
  applyFieldEdit(st, { pointer: '/rules/0/when', kind: 'json', raw: '{"fact":"loss.cause","op":"eq","value":"glass"}' });
  assert.equal(st.cfg.rules[0].when.value, 'glass');
  applyFieldEdit(st, { pointer: '/rules/0/when', kind: 'json', raw: '{oops' });
  assert.match(st.localErrors['/rules/0/when'], /Invalid JSON/);
  assert.equal(st.rawText['/rules/0/when'], '{oops');
  assert.equal(st.cfg.rules[0].when.value, 'glass', 'config keeps last good value');
  applyFieldEdit(st, { pointer: '/rules/0/when', kind: 'json', raw: 'true' });
  assert.equal(st.cfg.rules[0].when, true);
  assert.equal(st.localErrors['/rules/0/when'], undefined);
  applyFieldEdit(st, { pointer: '/lobs/0/label', kind: 'i18n', locale: 'es', raw: 'Auto' });
  assert.deepEqual(st.cfg.lobs[0].label, { en: 'A', es: 'Auto' });
  const r = applyFieldEdit(st, { pointer: '/locales', kind: 'csv', raw: 'en, fr-CA' });
  assert.equal(r.structural, true);
  assert.deepEqual(st.cfg.locales, ['en', 'fr-CA']);
  applyFieldEdit(st, { pointer: '/locales', kind: 'csv', raw: 'en, English' });
  assert.match(st.localErrors['/locales'], /English/);
  assert.deepEqual(st.cfg.locales, ['en', 'fr-CA']);
  applyFieldEdit(st, { pointer: '/questionSets/0/questions/0/showIf', kind: 'json', raw: '' });
  assert.equal('showIf' in st.cfg.questionSets[0].questions[0], false);
});

test('applyListAction adds typed items, resets transient state and tracks the question set index', () => {
  const st = { cfg: cfg(), localErrors: { '/x': 'e' }, rawText: { '/x': 'r' }, report: { valid: false }, qSet: 0 };
  applyListAction(st, 'add', '/rules');
  assert.equal(st.cfg.rules.length, 2);
  assert.deepEqual(st.localErrors, {});
  assert.equal(st.report, null);
  applyListAction(st, 'add', '/questionSets');
  assert.equal(st.qSet, 1);
  applyListAction(st, 'add', '/questionSets/1/questions');
  assert.equal(st.cfg.questionSets[1].questions.length, 2);
  applyListAction(st, 'remove', '/questionSets', 1);
  assert.equal(st.qSet, 0);
  applyListAction(st, 'add', '/timers');
  assert.equal(st.cfg.timers[1].state, 'WI');
  applyListAction(st, 'down', '/lobs', 0);
  assert.equal(st.cfg.lobs[0].id, 'b');
  assert.throws(() => applyListAction(st, 'add', '/nothing'));
  assert.throws(() => applyListAction(st, 'explode', '/lobs'));
});
