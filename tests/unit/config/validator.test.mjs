import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../../../src/modules/config/validator.js';

const ok = (schema, data, opts) => assert.deepEqual(validate(schema, data, opts).errors, []);
const bad = (schema, data, code, opts) => {
  const r = validate(schema, data, opts);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.code === code), `expected ${code}, got ${JSON.stringify(r.errors)}`);
  return r;
};

test('type: string, integer, number, boolean, null, array, object', () => {
  ok({ type: 'string' }, 'a');
  bad({ type: 'string' }, 1, 'type');
  ok({ type: 'integer' }, 3);
  bad({ type: 'integer' }, 3.5, 'type');
  ok({ type: 'number' }, 3.5);
  bad({ type: 'number' }, '3', 'type');
  ok({ type: 'boolean' }, false);
  ok({ type: 'null' }, null);
  bad({ type: 'object' }, [], 'type');
  bad({ type: 'array' }, {}, 'type');
  ok({ type: ['string', 'null'] }, null);
});

test('required, properties and additionalProperties report JSON-pointer paths', () => {
  const s = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'string' }, b: { type: 'integer' } } };
  ok(s, { a: 'x', b: 1 });
  assert.equal(bad(s, {}, 'required').errors[0].path, '/a');
  assert.equal(bad(s, { a: 'x', c: 1 }, 'additionalProperties').errors[0].path, '/c');
  assert.equal(bad(s, { a: 'x', b: 'no' }, 'type').errors[0].path, '/b');
  ok({ type: 'object', additionalProperties: { type: 'integer' } }, { x: 1 });
  bad({ type: 'object', additionalProperties: { type: 'integer' } }, { x: 'a' }, 'type');
});

test('items, minItems, maxItems, uniqueItems', () => {
  const s = { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 3, uniqueItems: true };
  ok(s, [1, 2]);
  bad(s, [], 'minItems');
  bad(s, [1, 2, 3, 4], 'maxItems');
  bad(s, [1, 1], 'uniqueItems');
  assert.equal(bad(s, [1, 'x'], 'type').errors[0].path, '/1');
});

test('enum and const', () => {
  ok({ enum: ['a', 'b'] }, 'a');
  bad({ enum: ['a', 'b'] }, 'c', 'enum');
  ok({ const: false }, false);
  bad({ const: false }, true, 'const');
});

test('pattern, minLength, maxLength, format', () => {
  ok({ type: 'string', pattern: '^[A-Z]{2}$' }, 'WI');
  bad({ type: 'string', pattern: '^[A-Z]{2}$' }, 'wi', 'pattern');
  bad({ type: 'string', minLength: 3 }, 'ab', 'minLength');
  bad({ type: 'string', maxLength: 1 }, 'ab', 'maxLength');
  ok({ type: 'string', format: 'date' }, '2026-02-03');
  bad({ type: 'string', format: 'date' }, '2026-13-45', 'format');
  ok({ type: 'string', format: 'date-time' }, '2026-02-03T04:05:06Z');
  bad({ type: 'string', format: 'email' }, 'nope', 'format');
});

test('minimum, maximum, exclusive bounds', () => {
  const s = { type: 'number', minimum: 0, maximum: 10 };
  ok(s, 0);
  ok(s, 10);
  bad(s, -1, 'minimum');
  bad(s, 11, 'maximum');
  bad({ exclusiveMinimum: 0 }, 0, 'exclusiveMinimum');
  bad({ exclusiveMaximum: 1 }, 1, 'exclusiveMaximum');
});

test('oneOf, anyOf, allOf, not', () => {
  const one = { oneOf: [{ type: 'string' }, { type: 'integer' }] };
  ok(one, 'a');
  ok(one, 2);
  bad(one, true, 'oneOf');
  bad({ oneOf: [{ type: 'integer' }, { minimum: 0 }] }, 5, 'oneOf'); // matches both
  ok({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 3);
  bad({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, null, 'anyOf');
  ok({ allOf: [{ type: 'integer' }, { minimum: 2 }] }, 3);
  bad({ allOf: [{ type: 'integer' }, { minimum: 2 }] }, 1, 'minimum');
  ok({ not: { type: 'string' } }, 1);
  bad({ not: { type: 'string' } }, 'a', 'not');
});

test('oneOf failures name the closest branch', () => {
  const s = { oneOf: [{ type: 'object', required: ['x'] }, { type: 'object', required: ['y'] }] };
  const r = bad(s, {}, 'oneOf');
  assert.match(r.errors.at(-1).message, /closest/);
});

test('propertyNames', () => {
  const s = { type: 'object', propertyNames: { pattern: '^[a-z]{2}$' } };
  ok(s, { en: 'x' });
  bad(s, { ENGLISH: 'x' }, 'pattern');
});

test('$ref: local pointers and recursion', () => {
  const s = { $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' }, v: { type: 'integer' } } } }, $ref: '#/$defs/Node' };
  ok(s, { v: 1, next: { v: 2, next: { v: 3 } } });
  assert.equal(bad(s, { next: { next: { v: 'x' } } }, 'type').errors[0].path, '/next/next/v');
  bad({ $ref: '#/$defs/Missing' }, 1, 'bad_ref');
});

test('$ref: sibling files go through resolve()', () => {
  const files = { 'common.json': { $defs: { Id: { type: 'string', pattern: '^id_' } } } };
  const resolve = (f) => files[f];
  const s = { type: 'object', properties: { id: { $ref: 'common.json#/$defs/Id' } } };
  ok(s, { id: 'id_1' }, { resolve });
  bad(s, { id: 'x' }, 'pattern', { resolve });
});

test('$ref: default resolver loads contract schemas from architecture/contracts/domain', () => {
  const s = { $ref: 'common.schema.json#/$defs/UsState' };
  ok(s, 'WI');
  bad(s, 'Wisconsin', 'pattern');
});

test('annotations are ignored and unknown keywords do not fail', () => {
  ok({ type: 'string', description: 'x', default: 'y', examples: ['z'], 'x-pii': true, title: 'T' }, 'a');
});

test('depth guard stops runaway recursive schemas', () => {
  const s = { $ref: '#' , properties: {} };
  const r = validate({ $ref: '#' }, 1);
  assert.equal(r.valid, false);
  assert.ok(s);
});
