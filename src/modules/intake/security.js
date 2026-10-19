// Intake security helpers (S4-WFL-02, closes SEC3-002/003/004 and answer size caps). Pure functions plus
// thin crypto wrappers over ctx.crypto.encryptPii/decryptPii. Nothing here logs answer or narrative content.
import vm from 'node:vm';

export const MAX_ANSWER_BYTES = 16 * 1024;
export const MAX_SESSION_ANSWER_BYTES = 512 * 1024;
export const MAX_PATTERN_LEN = 200;
export const MAX_PATTERN_INPUT = 200;
export const PATTERN_TIMEOUT_MS = 50;
export const MAX_IDEMPOTENCY_KEY = 128;

// ---------------------------------------------------------------- idempotency (SEC3-002)

const KEY_RE = /^[A-Za-z0-9._:-]+$/;

/**
 * Namespace a client Idempotency-Key under the session so it can never address another session's claim.
 * No client key -> `intake:<sessionId>`. Invalid key (too long or outside [A-Za-z0-9._:-]) -> throws via `fail`.
 */
export function namespacedKey(sessionId, clientKey, fail = (m) => new Error(m)) {
  if (clientKey === undefined || clientKey === null || clientKey === '') return `intake:${sessionId}`;
  if (typeof clientKey !== 'string' || clientKey.length > MAX_IDEMPOTENCY_KEY || !KEY_RE.test(clientKey)) {
    throw fail(`Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY} characters of letters, digits, . _ : -`);
  }
  return `intake:${sessionId}:${clientKey}`;
}

// ---------------------------------------------------------------- suggestions at rest (SEC3-004)

/** Seal a suggestions array for storage (opaque string). */
export function sealSuggestions(ctx, suggestions) {
  return ctx.crypto.encryptPii(JSON.stringify(suggestions));
}

/** Open sealed suggestions. Returns [] when unreadable (fail closed: the claimant can re-send the narrative). */
export function openSuggestions(ctx, sealed) {
  try {
    const v = JSON.parse(ctx.crypto.decryptPii(sealed));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// ---------------------------------------------------------------- answer sizes

const byteLen = (v) => (v === undefined ? 0 : Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8'));

/** Serialized size of one answer value in bytes. */
export const answerBytes = byteLen;

/**
 * Check one new value and the running session total.
 * @returns {string|null} error message, or null when within limits
 */
export function checkAnswerSize(value, sessionBytesAfter) {
  if (byteLen(value) > MAX_ANSWER_BYTES) return `Answer value exceeds ${MAX_ANSWER_BYTES} bytes`;
  if (sessionBytesAfter > MAX_SESSION_ANSWER_BYTES) return `Session answers exceed ${MAX_SESSION_ANSWER_BYTES} bytes`;
  return null;
}

// ---------------------------------------------------------------- validation.pattern guard (SEC3-003)

const COUNT_RE = /^\{(\d+)(,(\d*))?\}/;

/** Parse a regex source into { items, alt } or null when unsupported/malformed. Items: { min, max, body? }. */
function parse(p) {
  let i = 0;
  let bad = false;
  function quant() {
    const c = p[i];
    let min; let max; let len = 0;
    if (c === '*') { min = 0; max = Infinity; len = 1; }
    else if (c === '+') { min = 1; max = Infinity; len = 1; }
    else if (c === '?') { min = 0; max = 1; len = 1; }
    else if (c === '{') {
      const m = COUNT_RE.exec(p.slice(i));
      if (!m) return null;
      min = Number(m[1]);
      max = m[2] === undefined ? min : (m[3] === '' ? Infinity : Number(m[3]));
      if (max < min) bad = true;
      len = m[0].length;
    } else return null;
    i += len;
    if (p[i] === '?') i += 1; // lazy modifier
    const n = p[i];
    if (n === '*' || n === '+' || n === '?' || (n === '{' && COUNT_RE.test(p.slice(i)))) bad = true; // stacked quantifiers
    return { min, max };
  }
  function seq(depth) {
    const items = [];
    let alt = false;
    while (i < p.length && !bad) {
      const c = p[i];
      if (c === ')') { if (depth === 0) bad = true; break; }
      if (c === '|') { alt = true; i += 1; continue; }
      let item;
      if (c === '(') {
        i += 1;
        if (p[i] === '?') { if (p[i + 1] === ':') i += 2; else { bad = true; break; } }
        const inner = seq(depth + 1);
        if (p[i] !== ')') { bad = true; break; }
        i += 1;
        item = { min: 1, max: 1, body: inner };
      } else if (c === '[') {
        i += 1;
        if (p[i] === '^') i += 1;
        if (p[i] === ']') i += 1;
        while (i < p.length && p[i] !== ']') i += p[i] === '\\' ? 2 : 1;
        if (i >= p.length) { bad = true; break; }
        i += 1;
        item = { min: 1, max: 1 };
      } else if (c === '\\') {
        i += 2;
        item = { min: 1, max: 1 };
      } else if (c === '*' || c === '+' || c === '?') {
        bad = true; break; // nothing to repeat
      } else {
        i += 1;
        item = { min: 1, max: 1, anchor: c === '^' || c === '$' };
      }
      const q = quant();
      if (q) { item.min = q.min; item.max = q.max; }
      items.push(item);
    }
    return { items, alt };
  }
  const out = seq(0);
  if (bad || i < p.length) return null;
  return out;
}

const unbounded = (it) => it.max === Infinity;
const variable = (it) => it.min !== it.max;
const anyDeep = (node, pred) => node.items.some((it) => pred(it) || (it.body && anyDeep(it.body, pred)));

function safeNode(node) {
  let prevUnbounded = false;
  for (const it of node.items) {
    if (it.anchor) continue;
    if (it.body) {
      const inner = it.body;
      if (!safeNode(inner)) return false;
      const repeated = it.max > 1;
      // (x+)+ , (a|b)* , (a?){1,50}: repeated group whose body can match the same text several ways.
      if (repeated && (inner.alt || anyDeep(inner, (x) => x.max > 1 && (variable(x) || unbounded(x))) || anyDeep(inner, variable))) return false;
    }
    const nullable = it.min === 0;
    const isUnb = unbounded(it) || (it.body && anyDeep(it.body, unbounded));
    // adjacent / repeated unbounded quantifiers (a*a*, .*.*, a*b?a*): only nullable items may separate them
    if (isUnb) {
      if (prevUnbounded) return false;
      prevUnbounded = true;
    } else if (!nullable) prevUnbounded = false;
  }
  return true;
}

/** Conservative ReDoS precheck. Rejects backrefs, lookarounds, nested/adjacent/repeated unbounded quantifiers, counted groups with optional bodies. */
export function isSafePattern(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATTERN_LEN) return false;
  if (/\\[1-9]|\\k</.test(p) || /\(\?[=!<]/.test(p)) return false;
  const tree = parse(p);
  return !!tree && safeNode(tree);
}

const script = new vm.Script('re.test(s)');

/**
 * Hard time-box: run re.test(s) in a throwaway vm context with a timeout. Returns true/false, or null on timeout.
 * (Defence in depth: isSafePattern is the primary guard.)
 */
export function runPattern(re, s, timeoutMs = PATTERN_TIMEOUT_MS) {
  try {
    return script.runInNewContext({ re, s }, { timeout: timeoutMs }) === true;
  } catch { return null; }
}
