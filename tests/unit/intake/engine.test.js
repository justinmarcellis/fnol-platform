import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applicable, buildFacts, localize, plan, validateAnswer } from '../../../src/modules/intake/questions.js';
import { toClaimCreate } from '../../../src/modules/intake/mapping.js';
import { evaluateCondition } from '../../../src/modules/rules/condition.js';

const T = (en, es) => ({ en, es });

test('localize falls back to en', () => {
  assert.equal(localize(T('a', 'b'), 'es'), 'b');
  assert.equal(localize(T('a', 'b'), 'fr'), 'a');
  assert.equal(localize({ en: 'a' }, 'es-MX'), 'a');
  assert.equal(localize(undefined), '');
});

test('applicable orders by `order` then position and honours showIf/requiredIf/forced', () => {
  const set = { questions: [
    { id: 'b', text: T('b', 'b'), type: 'text', order: 20 },
    { id: 'a', text: T('a', 'a'), type: 'text', order: 10, required: true },
    { id: 'c', text: T('c', 'c'), type: 'text', showIf: { fact: 'answers.a', op: 'eq', value: 'x' }, requiredIf: { fact: 'session.channel', op: 'eq', value: 'csr_phone' } },
  ] };
  const f1 = buildFacts({ lob: 'l', channel: 'csr_phone' }, {});
  let r = applicable(set, f1, evaluateCondition);
  assert.deepEqual(r.visible.map((q) => q.id), ['a', 'b']);
  const f2 = buildFacts({ lob: 'l', channel: 'csr_phone' }, { a: { value: 'x' } });
  r = applicable(set, f2, evaluateCondition, new Set(['b']));
  assert.deepEqual(r.visible.map((q) => q.id), ['a', 'b', 'c']);
  assert.deepEqual([...r.required].sort(), ['a', 'b', 'c']);
  const p = plan(r.visible, r.required, { a: { value: 'x' } });
  assert.equal(p.next.id, 'b');
  assert.equal(p.progress.requiredRemaining, 2);
  assert.equal(p.progress.percent, 33);
});

test('validateAnswer by type, with Spanish messages', () => {
  const v = (type, value, extra = {}) => validateAnswer({ id: 'q', type, ...extra }, value, { today: '2026-10-18' });
  assert.equal(v('number', '12', { validation: { min: 1, max: 20 } }), null);
  assert.match(v('number', 21, { validation: { max: 20 } }), /at most/);
  assert.match(v('currency', 'x'), /number/);
  assert.equal(v('date', '2026-10-18', { validation: { notInFuture: true } }), null);
  assert.match(v('date', '2026-10-19', { validation: { notInFuture: true } }), /future/);
  assert.match(validateAnswer({ type: 'date', validation: { notInFuture: true } }, '2026-10-19', { locale: 'es', today: '2026-10-18' }), /futura/);
  assert.equal(v('time', '23:59'), null);
  assert.ok(v('time', '24:00'));
  assert.equal(v('email', 'a@b.co'), null);
  assert.ok(v('email', 'nope'));
  assert.equal(v('vin', '1HGCM82633A004352'), null);
  assert.ok(v('vin', '1HGCM82633A00435O'));
  assert.equal(v('multiselect', ['a'], { options: [{ value: 'a' }] }), null);
  assert.ok(v('multiselect', ['z'], { options: [{ value: 'a' }] }));
  assert.ok(v('text', 'abcdef', { validation: { maxLength: 3 } }));
  assert.equal(v('text', 'AB-1', { validation: { pattern: '^[A-Z]{2}-\\d$' } }), null);
  assert.ok(v('text', 'ab', { validation: { pattern: '^[A-Z]{2}-\\d$' } }));
  assert.equal(v('text', 'x', { validation: { pattern: '(' } }), null, 'bad tenant pattern does not block');
  assert.ok(v('text', ''));
  assert.equal(v('party', { firstName: 'Q' }), null);
  assert.ok(v('party', 'str'));
});

test('toClaimCreate maps paths, parties, vehicles and defaults the cause from loss type', () => {
  const qs = [
    { id: 'd', type: 'date', mapsTo: 'loss.lossDate' },
    { id: 'desc', type: 'longtext', mapsTo: 'lossEvent.description' },
    { id: 'loc', type: 'location', mapsTo: 'loss.location' },
    { id: 'ph', type: 'phone', mapsTo: 'parties[role=driver].phone' },
    { id: 'dr', type: 'boolean', mapsTo: 'vehicles[role=insured].drivable' },
    { id: 'op', type: 'party' },
    { id: 'disc', type: 'disclosure', mapsTo: 'loss.weather' },
    { id: 'evil', type: 'text', mapsTo: 'loss.__proto__.x' },
  ];
  const ans = (v, prov) => ({ value: v, answeredAt: 'now', ...(prov ? { provenance: prov } : {}) });
  const answers = {
    d: ans('2026-10-01', { source: 'ai_extraction', confirmedBy: 'u' }), desc: ans('text'), loc: ans({ state: 'WI' }), ph: ans('555-0100'), dr: ans(false),
    op: ans({ firstName: 'Q', roles: ['third_party', 'witness'] }), disc: ans(true), evil: ans('x'),
  };
  const { input, missing } = toClaimCreate({ id: 'isn_1', lob: 'personal_auto', lossType: 'glass', channel: 'csr_phone', policyNumber: 'P1' }, answers, qs, { lossTypes: [{ id: 'glass', causes: ['glass'] }] });
  assert.deepEqual(missing, []);
  assert.equal(input.lossEvent.lossDate, '2026-10-01');
  assert.equal(input.lossEvent.cause, 'glass');
  assert.equal(input.lossEvent.weather, undefined);
  assert.equal(input.riskState, 'WI');
  assert.equal(input.intakeSessionId, 'isn_1');
  assert.deepEqual(input.vehicles, [{ role: 'insured', drivable: false }]);
  assert.deepEqual(input.parties[0], { roles: ['driver'], kind: 'person', phone: '555-0100' });
  assert.deepEqual(input.parties[1].roles, ['third_party', 'witness']);
  assert.equal(input.lossEvent.fieldProvenance.lossDate.source, 'ai_extraction');
  assert.equal({}.x, undefined, 'no prototype pollution');
  assert.deepEqual(toClaimCreate({ id: 's', lob: 'l', channel: 'c' }, {}, qs).missing, ['lossEvent.lossDate']);
});
