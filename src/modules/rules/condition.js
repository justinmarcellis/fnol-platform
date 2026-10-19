// Condition language v1 (common.schema.json#/$defs/Condition, domain-model.md section 4).
// Pure and deterministic: no I/O, no clock reads, no randomness. Callers pass `now` inside the facts.
import { isSafePattern, matchWithBudget, MAX_PATTERN_LEN } from '../../core/safe-pattern.mjs';

export const OPERATORS = Object.freeze([
  'eq', 'ne', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'between',
  'exists', 'missing', 'contains', 'matches', 'any_eq', 'count_gte', 'within_days',
]);

export const FACT_PATTERN = /^(claim|loss|policy|coverage|triage|parties|vehicles|property|evidence|answers|session|tenant|now)(\.[A-Za-z0-9_[\]*]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Thrown for a malformed condition (unknown operator, bad value shape). */
export class ConditionError extends Error {
  constructor(message, path = '') {
    super(message);
    this.name = 'ConditionError';
    this.code = 'invalid_condition';
    this.path = path;
  }
}

// ---------------------------------------------------------------- fact lookup

/** Split "vehicles[*].drivable" into ['vehicles', '[*]', 'drivable']; "a[2]" gives ['a', '[2]']. */
function tokens(path) {
  const out = [];
  for (const part of String(path).split('.')) {
    const m = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(part);
    if (!m) { out.push(part); continue; }
    if (m[1]) out.push(m[1]);
    for (const b of m[2].matchAll(/\[([^\]]*)\]/g)) out.push(`[${b[1]}]`);
  }
  return out;
}

/**
 * Resolve a fact path. `[*]` projects an array (results are flattened one level per projection).
 * @param {object} facts
 * @param {string} path
 * @returns {*} the value, or undefined when any step is missing
 */
export function resolveFact(facts, path) {
  let cur = [facts];
  let projected = false;
  for (const tok of tokens(path)) {
    const next = [];
    for (const v of cur) {
      if (v === null || v === undefined) continue;
      if (tok === '[*]') {
        if (Array.isArray(v)) next.push(...v);
      } else if (/^\[\d+\]$/.test(tok)) {
        if (Array.isArray(v) && v[Number(tok.slice(1, -1))] !== undefined) next.push(v[Number(tok.slice(1, -1))]);
      } else if (typeof v === 'object' && Object.hasOwn(v, tok)) {
        next.push(v[tok]);
      }
    }
    if (tok === '[*]') projected = true;
    if (!next.length && tok !== '[*]') return undefined;
    cur = next;
  }
  if (projected) {
    const vals = cur.filter((x) => x !== undefined && x !== null);
    return vals.length ? vals : undefined;
  }
  return cur[0];
}

// ---------------------------------------------------------------- comparison helpers

const isMissing = (v) => v === undefined || v === null;

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

/** Order two comparable values: numbers, or ISO date/time strings. Returns null when not comparable. */
function compare(a, b) {
  if (typeof a === 'number' && typeof b === 'number' && !Number.isNaN(a) && !Number.isNaN(b)) return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string' && ISO_DATE.test(a) && ISO_DATE.test(b)) {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta < tb ? -1 : ta > tb ? 1 : 0;
  }
  return null;
}

/** Shared strict checker (src/core/safe-pattern.mjs): whitelist grammar, bounded quantifiers, no nesting hazards. */
export const isSafeRegex = isSafePattern;

function dayDiff(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb) || typeof a !== 'string' || typeof b !== 'string') return null;
  return Math.abs(ta - tb) / 86400000;
}

// ---------------------------------------------------------------- leaf evaluation

function evalLeaf(op, actual, value, facts) {
  switch (op) {
    case 'exists': return !isMissing(actual);
    case 'missing': return isMissing(actual);
    case 'ne': return isMissing(actual) ? true : !deepEqual(actual, value);
    default: break;
  }
  if (isMissing(actual)) return false;
  switch (op) {
    case 'eq': return deepEqual(actual, value);
    case 'in': return Array.isArray(value) && value.some((v) => deepEqual(v, actual));
    case 'nin': return Array.isArray(value) && !value.some((v) => deepEqual(v, actual));
    case 'gt': { const c = compare(actual, value); return c !== null && c > 0; }
    case 'gte': { const c = compare(actual, value); return c !== null && c >= 0; }
    case 'lt': { const c = compare(actual, value); return c !== null && c < 0; }
    case 'lte': { const c = compare(actual, value); return c !== null && c <= 0; }
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) return false;
      const lo = compare(actual, value[0]);
      const hi = compare(actual, value[1]);
      return lo !== null && hi !== null && lo >= 0 && hi <= 0;
    }
    case 'contains':
      if (Array.isArray(actual)) return actual.some((v) => deepEqual(v, value));
      if (typeof actual === 'string' && typeof value === 'string') return actual.toLowerCase().includes(value.toLowerCase());
      return false;
    case 'matches':
      return typeof actual === 'string' && typeof value === 'string' && matchWithBudget(value, actual) === true;
    case 'any_eq': return Array.isArray(actual) && actual.some((v) => deepEqual(v, value));
    case 'count_gte': return Array.isArray(actual) && typeof value === 'number' && actual.length >= value;
    case 'within_days': {
      let days = value;
      let anchor = facts?.now;
      if (value && typeof value === 'object') {
        days = value.days;
        anchor = resolveFact(facts, value.of);
      }
      if (typeof days !== 'number' || isMissing(anchor)) return false;
      const d = dayDiff(actual, anchor);
      return d !== null && d <= days;
    }
    default: throw new ConditionError(`unknown operator "${op}"`);
  }
}

// ---------------------------------------------------------------- public API

/**
 * Evaluate a condition against a fact document.
 * Combinators short-circuit, so only leaves that were actually evaluated appear in the trace.
 * A missing fact makes every comparison false except `missing` and `ne`.
 * @param {boolean|object} condition
 * @param {object} facts
 * @returns {{ result: boolean, trace: { fact: string, op: string, value: *, actual: *, result: boolean }[] }}
 * @throws {ConditionError} on an unknown operator or malformed node
 */
export function evaluateCondition(condition, facts = {}) {
  const trace = [];
  const f = facts ?? {};

  function walk(node, path) {
    if (typeof node === 'boolean') return node;
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new ConditionError('condition must be an object or boolean', path);
    if ('all' in node) {
      if (!Array.isArray(node.all)) throw new ConditionError('"all" must be an array', path);
      for (let i = 0; i < node.all.length; i++) if (!walk(node.all[i], `${path}/all/${i}`)) return false;
      return true;
    }
    if ('any' in node) {
      if (!Array.isArray(node.any)) throw new ConditionError('"any" must be an array', path);
      for (let i = 0; i < node.any.length; i++) if (walk(node.any[i], `${path}/any/${i}`)) return true;
      return false;
    }
    if ('not' in node) return !walk(node.not, `${path}/not`);
    if (typeof node.fact !== 'string' || typeof node.op !== 'string') throw new ConditionError('leaf needs "fact" and "op"', path);
    if (!OPERATORS.includes(node.op)) throw new ConditionError(`unknown operator "${node.op}"`, path);
    const actual = resolveFact(f, node.fact);
    const result = evalLeaf(node.op, actual, node.value, f);
    trace.push({ fact: node.fact, op: node.op, value: node.value, actual, result });
    return result;
  }

  return { result: walk(condition, ''), trace };
}

/**
 * Structural check of a condition (no facts needed).
 * @param {*} condition
 * @param {string} [path] JSON pointer prefix for error paths
 * @returns {{ path: string, code: string, message: string }[]}
 */
export function validateCondition(condition, path = '') {
  const errors = [];
  const err = (p, code, message) => errors.push({ path: p, code, message });

  function walk(node, p) {
    if (typeof node === 'boolean') return;
    if (!node || typeof node !== 'object' || Array.isArray(node)) { err(p, 'invalid_condition', 'condition must be an object or boolean'); return; }
    const keys = Object.keys(node);
    if ('all' in node || 'any' in node) {
      const k = 'all' in node ? 'all' : 'any';
      if (keys.length !== 1) err(p, 'invalid_condition', `"${k}" cannot be combined with other keys`);
      if (!Array.isArray(node[k]) || node[k].length === 0) { err(`${p}/${k}`, 'invalid_condition', `"${k}" must be a non-empty array`); return; }
      node[k].forEach((c, i) => walk(c, `${p}/${k}/${i}`));
      return;
    }
    if ('not' in node) {
      if (keys.length !== 1) err(p, 'invalid_condition', '"not" cannot be combined with other keys');
      walk(node.not, `${p}/not`);
      return;
    }
    if (typeof node.fact !== 'string' || typeof node.op !== 'string') { err(p, 'invalid_condition', 'leaf needs "fact" and "op"'); return; }
    const extra = keys.filter((k) => !['fact', 'op', 'value'].includes(k));
    if (extra.length) err(p, 'invalid_condition', `unexpected key "${extra[0]}"`);
    if (!FACT_PATTERN.test(node.fact)) err(`${p}/fact`, 'unknown_fact_root', `fact path "${node.fact}" is not valid`);
    if (!OPERATORS.includes(node.op)) { err(`${p}/op`, 'unknown_op', `unknown operator "${node.op}"`); return; }
    const v = node.value;
    const vp = `${p}/value`;
    switch (node.op) {
      case 'exists': case 'missing': break;
      case 'in': case 'nin':
        if (!Array.isArray(v)) err(vp, 'invalid_value', `"${node.op}" needs an array value`);
        break;
      case 'between':
        if (!Array.isArray(v) || v.length !== 2) err(vp, 'invalid_value', '"between" needs [lo, hi]');
        break;
      case 'matches':
        if (typeof v !== 'string' || !isSafeRegex(v)) err(vp, 'invalid_value', `"matches" needs a safe regex of at most ${MAX_PATTERN_LEN} characters (no lookaround, backreferences, nested or stacked quantifiers)`);
        break;
      case 'count_gte':
        if (typeof v !== 'number') err(vp, 'invalid_value', '"count_gte" needs a number');
        break;
      case 'within_days':
        if (!(typeof v === 'number' || (v && typeof v === 'object' && typeof v.days === 'number' && FACT_PATTERN.test(String(v.of))))) {
          err(vp, 'invalid_value', '"within_days" needs a number or { of: <fact path>, days: <number> }');
        }
        break;
      case 'gt': case 'gte': case 'lt': case 'lte':
        if (typeof v !== 'number' && !(typeof v === 'string' && ISO_DATE.test(v))) err(vp, 'invalid_value', `"${node.op}" needs a number or ISO date`);
        break;
      default:
        if (!('value' in node)) err(vp, 'invalid_value', `"${node.op}" needs a value`);
    }
  }

  walk(condition, path);
  return errors;
}
