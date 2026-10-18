import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { generatePolicies, SCENARIOS, generateScenario, isValidVin, computeCheckDigit, createRng } from './index.mjs';

const DOMAIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'architecture', 'contracts', 'domain');
const load = (f) => JSON.parse(readFileSync(join(DOMAIN, f), 'utf8'));
const common = load('common.schema.json');

/** Tiny validator: type, required, enum, pattern, min/max, items, properties, additionalProperties:false, $ref. */
function validate(schema, value, path = '$', file = 'common.schema.json', errors = []) {
  if (schema.$ref) {
    const [f, ptr] = schema.$ref.split('#');
    const targetFile = f || file;
    let target = load(targetFile);
    for (const seg of (ptr || '').split('/').filter(Boolean)) target = target[seg];
    return validate(target, value, path, targetFile, errors);
  }
  const t = schema.type;
  if (t) {
    const ok = { string: typeof value === 'string', number: typeof value === 'number', integer: Number.isInteger(value), boolean: typeof value === 'boolean', array: Array.isArray(value), object: value && typeof value === 'object' && !Array.isArray(value) }[t];
    if (!ok) { errors.push(`${path}: expected ${t}`); return errors; }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${value} not in enum`);
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: ${value} fails pattern`);
  if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push(`${path}: bad date`);
  if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${path}: bad date-time`);
  if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
  if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: too long`);
  if (t === 'array') value.forEach((v, i) => schema.items && validate(schema.items, v, `${path}[${i}]`, file, errors));
  if (t === 'object') {
    for (const r of schema.required || []) if (!(r in value)) errors.push(`${path}: missing ${r}`);
    for (const [k, v] of Object.entries(value)) {
      const ps = schema.properties?.[k];
      if (ps) validate(ps, v, `${path}.${k}`, file, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected ${k}`);
    }
  }
  return errors;
}

const policySchema = load('PolicySnapshot.schema.json');
const LOB_CASES = [['auto', 'personal_auto'], ['home', 'homeowners'], ['commercial_auto', 'commercial_auto']];

test('common schema sanity (validator wiring)', () => {
  assert.ok(common.$defs.Lob);
  assert.ok(validate(policySchema, {}).length > 0);
});

for (const [input, lob] of LOB_CASES) {
  test(`generatePolicies ${input}: schema-valid, deterministic`, () => {
    const a = generatePolicies({ tenantId: 'northwind', lob: input, count: 6, seed: 42, state: 'IL' });
    assert.equal(a.length, 6);
    for (const p of a) {
      assert.deepEqual(validate(policySchema, p), []);
      assert.equal(p.lob, lob);
      assert.equal(p.ratingState, 'IL');
      assert.ok(p.period.effectiveDate.startsWith('2026'));
    }
    assert.deepEqual(generatePolicies({ tenantId: 'northwind', lob: input, count: 6, seed: 42, state: 'IL' }), a);
    assert.notDeepEqual(generatePolicies({ tenantId: 'northwind', lob: input, count: 6, seed: 43, state: 'IL' }), a);
    assert.equal(new Set(a.map((p) => p.policyNumber)).size, 6);
  });
}

test('LOB coverage shapes', () => {
  const [auto] = generatePolicies({ lob: 'personal_auto', seed: 1 });
  const bi = auto.coverages.find((c) => c.code === 'BI');
  assert.equal(bi.limitPerPerson.amount, 100000);
  assert.equal(bi.limitPerOccurrence.amount, 300000);
  assert.equal(auto.vehicles[0].coverages.find((c) => c.code === 'COLL').deductible.amount, 500);
  const [home] = generatePolicies({ lob: 'homeowners', seed: 1 });
  assert.ok(home.coverages.find((c) => c.code === 'DWELLING').limit.amount >= 200000);
  assert.equal(home.properties[0].coverages[0].deductible.amount, 1000);
  for (const p of generatePolicies({ lob: 'commercial_auto', count: 12, seed: 5 })) {
    assert.ok(p.vehicles.length >= 5 && p.vehicles.length <= 10);
  }
  assert.throws(() => generatePolicies({ lob: 'boat' }));
});

test('VINs are 17 chars with valid check digit', () => {
  const vins = generatePolicies({ lob: 'commercial_auto', count: 10, seed: 9 }).flatMap((p) => p.vehicles.map((v) => v.vin));
  assert.ok(vins.length >= 50);
  for (const v of vins) {
    assert.equal(v.length, 17);
    assert.match(v, /^[A-HJ-NPR-Z0-9]{17}$/);
    assert.equal(v[8], computeCheckDigit(v));
    assert.ok(isValidVin(v));
  }
  assert.ok(isValidVin('1M8GDM9AXKP042788'), 'known public example VIN');
  assert.ok(!isValidVin('1M8GDM9A1KP042788'));
});

test('PRNG is seeded and repeatable', () => {
  const a = createRng('x'); const b = createRng('x');
  assert.deepEqual([a.next(), a.next(), a.int(1, 9)], [b.next(), b.next(), b.int(1, 9)]);
});

const REQUIRED = ['auto_rear_end_injury', 'auto_glass_only', 'auto_theft_late_report', 'auto_hit_and_run', 'home_water_small', 'home_fire_large', 'home_loss_before_inception', 'commercial_auto_fleet_collision'];

test('SCENARIOS contains the 8 named scenarios', () => {
  for (const n of REQUIRED) assert.ok(SCENARIOS[n], n);
});

const claimCreateSchema = { type: 'object', required: ['lob', 'lossEvent'], additionalProperties: false, properties: {
  tenantId: { $ref: 'common.schema.json#/$defs/TenantId' }, lob: { $ref: 'common.schema.json#/$defs/Lob' }, lossType: { type: 'string' },
  channel: { type: 'string', enum: ['api', 'partner', 'email', 'csr_phone'] }, policyNumber: { type: 'string' }, riskState: { $ref: 'common.schema.json#/$defs/UsState' },
  lossEvent: { $ref: 'LossEvent.schema.json' }, parties: { type: 'array', items: { $ref: 'Party.schema.json' } },
  vehicles: { type: 'array', items: { $ref: 'Vehicle.schema.json' } }, properties: { type: 'array', items: { $ref: 'Property.schema.json' } },
  externalRef: { type: 'object' } } };

for (const name of REQUIRED) {
  test(`scenario ${name}: shape, contract-valid, deterministic`, () => {
    const s = generateScenario(name, { seed: 7 });
    assert.equal(s.name, name);
    assert.equal(s.lob, SCENARIOS[name].lob);
    assert.ok(s.lossType);
    assert.ok(s.intakeAnswers.lossDate && s.intakeAnswers.lossDescription);
    assert.deepEqual(Object.keys(s.expected).sort(), ['coverageStatus', 'fastTrack', 'fraud', 'severityBand', 'subrogation']);
    assert.deepEqual(validate(claimCreateSchema, s.claimCreate), []);
    assert.deepEqual(validate(policySchema, s.policy), []);
    assert.ok(s.documents.length >= 1);
    assert.deepEqual(generateScenario(name, { seed: 7 }), s);
    assert.notDeepEqual(generateScenario(name, { seed: 8 }), s);
    assert.deepEqual(generateScenario({ name, seed: 7 }), s);
    assert.ok(!/Math\.random/.test(JSON.stringify(s)));
  });
}

test('scenario expectations', () => {
  const g = (n) => generateScenario(n, { seed: 11 });
  assert.equal(g('auto_rear_end_injury').expected.subrogation, true);
  assert.equal(g('auto_rear_end_injury').expected.fastTrack, false);
  assert.ok(['moderate', 'major'].includes(g('auto_rear_end_injury').expected.severityBand));
  assert.equal(g('auto_glass_only').expected.fastTrack, true);
  const theft = g('auto_theft_late_report');
  assert.equal(theft.expected.fraud, true);
  assert.ok(theft.meta.reportDelayDays >= 7);
  assert.equal(g('auto_hit_and_run').claimCreate.lossEvent.cause, 'hit_and_run');
  const water = g('home_water_small');
  assert.equal(water.expected.fastTrack, true);
  assert.ok(water.meta.estimateTotal < 2500);
  assert.equal(g('home_fire_large').expected.severityBand, 'severe');
  const early = g('home_loss_before_inception');
  assert.ok(early.claimCreate.lossEvent.lossDate < early.policy.period.effectiveDate);
  assert.equal(early.expected.coverageStatus, 'not_covered');
  const fleet = g('commercial_auto_fleet_collision');
  assert.ok(fleet.policy.vehicles.length >= 5);
  assert.throws(() => generateScenario('nope'));
});

test('police report and estimate documents are realistic and sum correctly', () => {
  const s = generateScenario('auto_rear_end_injury', { seed: 2 });
  const pr = s.documents.find((d) => d.kind === 'police_report');
  assert.match(pr.text, /Report No\.: RB-\d+/);
  assert.match(pr.text, /NARRATIVE/);
  assert.match(pr.text, /CITATIONS/);
  assert.match(pr.text, /Following too closely/);
  assert.equal(pr.contentType, 'text/plain');
  const est = s.documents.find((d) => d.kind === 'estimate');
  assert.match(est.text, /LINE ITEMS/);
  assert.match(est.text, /TOTAL:/);
  const m = est.metadata;
  const sum = m.lineItems.reduce((a, i) => a + i.amountCents, 0);
  assert.ok(m.lineItems.some((i) => i.type === 'part') && m.lineItems.some((i) => i.type === 'labor'));
  assert.equal(Math.round((sum / 100 + m.tax) * 100), Math.round(m.total * 100));
  assert.equal(Math.round((m.partsTotal + m.laborTotal + m.tax) * 100), Math.round(m.total * 100));
  assert.ok(est.text.includes(m.total.toFixed(2)));
  const photo = s.documents.find((d) => d.kind === 'photo');
  assert.match(photo.contentBase64, /^[A-Za-z0-9+/=]+$/);
  for (const d of s.documents) for (const f of ['kind', 'filename', 'contentType']) assert.ok(d[f]);
});

test('no real carriers and phones use 555-01xx', () => {
  for (const name of REQUIRED) {
    const s = generateScenario(name, { seed: 4 });
    const blob = JSON.stringify(s);
    assert.ok(!/State Farm|Allstate|GEICO|Progressive|Liberty Mutual|Nationwide/i.test(blob));
    for (const p of s.claimCreate.parties) assert.match(p.phone, /555-01\d\d$/);
  }
});

test('source uses no Math.random or Date.now', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const f of ['index.mjs', 'prng.mjs', 'names.mjs', 'vin.mjs', 'documents.mjs']) {
    const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/Math\.random|Date\.now|new Date\(\)/.test(src), f);
    assert.ok(!/from '(?!node:|\.\/)/.test(src), `${f} has non-builtin import`);
  }
});
