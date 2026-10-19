// Zero-dependency JSON Schema subset validator.
// Supports: type, enum, const, required, properties, additionalProperties (bool|schema),
// propertyNames, items, minItems/maxItems, uniqueItems, minLength/maxLength, pattern,
// minimum/maximum, exclusiveMinimum/exclusiveMaximum, format (date, date-time, email),
// allOf/anyOf/oneOf/not, and $ref (local "#/..." and sibling files via a resolve callback).
// Annotations (description, default, examples, title, $schema, $id, x-*) are ignored.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafePattern } from '../../core/safe-pattern.mjs';

const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../architecture/contracts/domain');

const FORMATS = {
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)),
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)),
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
};

const UNSAFE = 'is not a safe pattern (whitelist grammar, counts <= 50, no nested or ambiguous quantifiers, max 200 characters)';

/** Tenant-authored regexes (any "pattern" string, any {op:"matches", value}) must pass the shared checker (SEC2-013/014). */
function scanPatterns(node, p, depth, errors) {
  if (depth > 64 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((x, i) => scanPatterns(x, `${p}/${i}`, depth + 1, errors)); return; }
  if (typeof node.pattern === 'string' && !isSafePattern(node.pattern)) errors.push({ path: `${p}/pattern`, code: 'unsafe_pattern', message: UNSAFE });
  if (node.op === 'matches' && typeof node.value === 'string' && !isSafePattern(node.value)) errors.push({ path: `${p}/value`, code: 'unsafe_pattern', message: UNSAFE });
  for (const [k, v] of Object.entries(node)) scanPatterns(v, `${p}/${k}`, depth + 1, errors);
}

/**
 * Create a resolver that loads sibling schema files from a directory.
 * @param {string} [dir] defaults to architecture/contracts/domain
 * @returns {(file: string) => object}
 */
export function fileResolver(dir = DEFAULT_DIR) {
  const cache = new Map();
  return (file) => {
    const name = path.basename(file);
    if (!cache.has(name)) cache.set(name, JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    return cache.get(name);
  };
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(v, t) {
  switch (t) {
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'object': return typeOf(v) === 'object';
    default: return typeOf(v) === t;
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pointer(root, ptr) {
  let cur = root;
  for (const part of ptr.split('/').filter(Boolean)) {
    cur = cur?.[decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cur;
}

/**
 * Validate data against a schema.
 * @param {object|boolean} schema
 * @param {*} data
 * @param {{ resolve?: (file: string) => object, root?: object }} [opts]
 *   resolve loads sibling schema documents for "file.json#/ptr" refs (default: contracts/domain).
 * @returns {{ valid: boolean, errors: { path: string, code: string, message: string }[] }}
 */
export function validate(schema, data, opts = {}) {
  const resolve = opts.resolve ?? fileResolver();
  const errors = [];

  function check(s, v, p, root, depth) {
    if (depth > 64) { errors.push({ path: p, code: 'depth', message: 'schema nesting too deep' }); return; }
    if (s === true || s === undefined) return;
    if (s === false) { errors.push({ path: p, code: 'false_schema', message: 'no value is allowed here' }); return; }

    if (s.$ref) {
      const [file, ptr = ''] = s.$ref.split('#');
      const target = file ? resolve(file) : root;
      const sub = ptr ? pointer(target, ptr) : target;
      if (sub === undefined) { errors.push({ path: p, code: 'bad_ref', message: `unresolvable $ref ${s.$ref}` }); return; }
      check(sub, v, p, target, depth + 1);
    }
    const at = p || '/';

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => matchesType(v, t))) {
        errors.push({ path: at, code: 'type', message: `must be ${types.join(' or ')}` });
        return;
      }
    }
    if (s.const !== undefined && !deepEqual(v, s.const)) errors.push({ path: at, code: 'const', message: `must equal ${JSON.stringify(s.const)}` });
    if (s.enum && !s.enum.some((e) => deepEqual(e, v))) errors.push({ path: at, code: 'enum', message: `must be one of ${s.enum.join(', ')}` });

    if (typeof v === 'string') {
      if (s.minLength !== undefined && v.length < s.minLength) errors.push({ path: at, code: 'minLength', message: `must have at least ${s.minLength} characters` });
      if (s.maxLength !== undefined && v.length > s.maxLength) errors.push({ path: at, code: 'maxLength', message: `must have at most ${s.maxLength} characters` });
      if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push({ path: at, code: 'pattern', message: `must match ${s.pattern}` });
      if (s.format && FORMATS[s.format] && !FORMATS[s.format](v)) errors.push({ path: at, code: 'format', message: `must be a valid ${s.format}` });
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push({ path: at, code: 'minimum', message: `must be >= ${s.minimum}` });
      if (s.maximum !== undefined && v > s.maximum) errors.push({ path: at, code: 'maximum', message: `must be <= ${s.maximum}` });
      if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) errors.push({ path: at, code: 'exclusiveMinimum', message: `must be > ${s.exclusiveMinimum}` });
      if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) errors.push({ path: at, code: 'exclusiveMaximum', message: `must be < ${s.exclusiveMaximum}` });
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push({ path: at, code: 'minItems', message: `must have at least ${s.minItems} items` });
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push({ path: at, code: 'maxItems', message: `must have at most ${s.maxItems} items` });
      if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errors.push({ path: at, code: 'uniqueItems', message: 'items must be unique' });
      if (s.items) v.forEach((item, i) => check(s.items, item, `${p}/${i}`, root, depth + 1));
    }
    if (typeOf(v) === 'object') {
      for (const k of s.required ?? []) {
        if (!(k in v)) errors.push({ path: `${p}/${k}`, code: 'required', message: 'is required' });
      }
      const props = s.properties ?? {};
      for (const [k, val] of Object.entries(v)) {
        if (s.propertyNames) {
          const before = errors.length;
          check(s.propertyNames, k, `${p}/${k}`, root, depth + 1);
          if (errors.length > before) continue;
        }
        if (k in props) check(props[k], val, `${p}/${k}`, root, depth + 1);
        else if (s.additionalProperties === false) errors.push({ path: `${p}/${k}`, code: 'additionalProperties', message: 'is not allowed' });
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, val, `${p}/${k}`, root, depth + 1);
      }
    }

    if (s.allOf) for (const sub of s.allOf) check(sub, v, p, root, depth + 1);
    if (s.anyOf) {
      const ok = s.anyOf.some((sub) => sub === true || trial(sub, v, p, root, depth));
      if (!ok) errors.push({ path: at, code: 'anyOf', message: 'must match at least one allowed shape' });
    }
    if (s.oneOf) {
      const n = s.oneOf.filter((sub) => trial(sub, v, p, root, depth)).length;
      if (n === 0) {
        // Surface the closest branch's first problem to make the failure actionable.
        const best = bestBranch(s.oneOf, v, p, root, depth);
        errors.push({ path: at, code: 'oneOf', message: `must match one allowed shape${best ? ` (closest: ${best.path || '/'} ${best.message})` : ''}` });
      } else if (n > 1) errors.push({ path: at, code: 'oneOf', message: 'matches more than one allowed shape' });
    }
    if (s.not && trial(s.not, v, p, root, depth)) errors.push({ path: at, code: 'not', message: 'must not match the excluded shape' });
  }

  // Evaluate a sub-schema in isolation and report whether it passed.
  function trial(sub, v, p, root, depth) {
    const saved = errors.length;
    check(sub, v, p, root, depth + 1);
    const ok = errors.length === saved;
    errors.length = saved;
    return ok;
  }

  function bestBranch(branches, v, p, root, depth) {
    let best = null;
    for (const sub of branches) {
      const saved = errors.length;
      check(sub, v, p, root, depth + 1);
      const found = errors.splice(saved);
      if (found.length && (!best || found.length < best.count)) best = { count: found.length, ...found[found.length - 1] };
    }
    return best;
  }

  const root = opts.root ?? schema;
  check(schema, data, '', root, 0);
  scanPatterns(data, '', 0, errors);
  return { valid: errors.length === 0, errors };
}
