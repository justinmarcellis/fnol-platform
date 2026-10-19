// Intake security helpers (S4-WFL-02, closes SEC3-002/003/004 and answer size caps). Pure functions plus
// thin crypto wrappers over ctx.crypto.encryptPii/decryptPii. Nothing here logs answer or narrative content.
import { isSafePattern, matchWithBudget, MAX_PATTERN_LEN, MAX_PATTERN_INPUT, PATTERN_TIMEOUT_MS } from '../../core/safe-pattern.mjs';

export const MAX_ANSWER_BYTES = 16 * 1024;
export const MAX_SESSION_ANSWER_BYTES = 512 * 1024;
export { MAX_PATTERN_LEN, MAX_PATTERN_INPUT, PATTERN_TIMEOUT_MS };
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
// The checker lives in src/core/safe-pattern.mjs (S5-WFL-02); these are thin re-exports for existing callers.

export { isSafePattern };

/** Time-boxed re.test(s); true/false, or null on timeout. Input over MAX_PATTERN_INPUT never matches. */
export function runPattern(re, s, timeoutMs = PATTERN_TIMEOUT_MS) {
  return matchWithBudget(re, s, { timeoutMs, maxInput: Infinity });
}
