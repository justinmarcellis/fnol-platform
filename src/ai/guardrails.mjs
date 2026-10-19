// AI guardrails: pure, zero-dependency layer that every provider call goes through.
//   sanitizeText  neutralise prompt-injection markers (never executes anything)
//   capInput      deterministic size cap
//   redact        PII placeholders for cloud providers (reverse map stays local)
//   validateOutput  mini JSON-schema check against src/ai/schemas.mjs
//   guard         wrap a provider: sanitize -> cap -> redact (cloud only) -> call -> validate
import { schemaFor, inputCapFor } from './schemas.mjs';

export const REMOVED = '[removed-instruction]';
export const DEFAULT_MAX_CHARS = 20000;
/** Hard ceiling on a single string handed to the sanitizer (defence in depth against pathological input). */
export const SANITIZE_MAX_CHARS = 200000;

// ---------- sanitize ----------
const INJECTION_PATTERNS_RAW = [
  // fenced blocks whose info string is a privileged role
  /```[ \t]*(?:system|assistant|developer)[^\n]*\n[\s\S]*?(?:```|$)/gi,
  // role tags
  /<\|?\s*(?:\/\s*)?(?:system|assistant|developer|im_start|im_end|user)\s*\|?>/gi,
  /<<\s*(?:\/\s*)?SYS\s*>>/gi,
  /\[\s*(?:\/\s*)?INST\s*\]/gi,
  // markdown role headings
  /^[ \t]*#{1,6}[ \t]*(?:system|assistant|developer)\b[^\n]*/gim,
  // "system:" style role prefixes at line start, or inline when followed by an imperative
  /^[ \t]*(?:system|assistant|developer)[ \t]*:/gim,
  /\b(?:system|developer)[ \t]*:(?=[ \t]*(?:you|ignore|disregard|do not|don't|act|from now|always|never|reveal|output))/gi,
  // classic override phrases
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,30}\b(?:previous|prior|above|earlier|preceding|all|any|your|the|these|those)\b[^.\n]{0,30}(?<!removed-)\b(?:instructions?|prompts?|rules?|guidelines?|directions?|context|constraints?)\b/gi,
  /\bforget\s+(?:everything|all)\b[^.\n]*/gi,
  /\bnew\s+instructions?\s*:/gi,
  /\byou\s+are\s+now\b[^.\n]*/gi,
  /\b(?:reveal|print|show|repeat)\b[^.\n]{0,20}\b(?:system|hidden)\s+prompt\b/gi,
];

// Phrase overrides run before tags so a replaced tag can never be re-matched.
const INJECTION_PATTERNS = [...INJECTION_PATTERNS_RAW.slice(-6), ...INJECTION_PATTERNS_RAW.slice(0, -6)];

/**
 * Replace prompt-injection markers with a visible [removed-instruction] token.
 * Case-insensitive, idempotent, never throws.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeText(text) {
  let s = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (s.length > SANITIZE_MAX_CHARS) s = s.slice(0, SANITIZE_MAX_CHARS);
  for (const re of INJECTION_PATTERNS) s = s.replace(re, REMOVED);
  return s.replace(/(?:\[removed-instruction\][ \t]*){2,}/g, `${REMOVED} `).replace(/\[removed-instruction\] (?=\n|$)/g, REMOVED);
}

/** @returns {number} how many markers sanitizeText would neutralise in text */
export function countInjections(text) {
  let s = typeof text === 'string' ? text : '';
  if (s.length > SANITIZE_MAX_CHARS) s = s.slice(0, SANITIZE_MAX_CHARS);
  let n = 0;
  for (const re of INJECTION_PATTERNS) n += (s.match(new RegExp(re.source, re.flags)) ?? []).length;
  return n;
}

// ---------- cap ----------
/**
 * Truncate text to maxChars. Deterministic (plain slice, no marker).
 * @param {string} text @param {number} [maxChars]
 * @returns {{text: string, truncated: boolean, originalLength: number}}
 */
export function capInput(text, maxChars = DEFAULT_MAX_CHARS) {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  const max = Number.isFinite(maxChars) && maxChars >= 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;
  if (s.length <= max) return { text: s, truncated: false, originalLength: s.length };
  return { text: s.slice(0, max), truncated: true, originalLength: s.length };
}

// ---------- structured walk helpers ----------
const isObj = (v) => v !== null && typeof v === 'object';

function mapStrings(value, fn, key = '') {
  if (typeof value === 'string') return fn(value, key);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, key));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn, k)]));
  return value;
}

/** Apply sanitizeText to every string in an input value. */
export function sanitizeValue(value) {
  return mapStrings(value, (s) => sanitizeText(s));
}

/**
 * Cap a structured input: the total string budget is maxChars, consumed in
 * deterministic (insertion-order) traversal; strings past the budget become ''.
 * @returns {{value: any, truncated: boolean, chars: number}}
 */
export function capValue(value, maxChars = DEFAULT_MAX_CHARS) {
  let budget = Number.isFinite(maxChars) && maxChars >= 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;
  let truncated = false;
  let chars = 0;
  const out = mapStrings(value, (s) => {
    chars += s.length;
    const r = capInput(s, budget);
    budget -= r.text.length;
    if (r.truncated) truncated = true;
    return r.text;
  });
  return { value: out, truncated, chars };
}

// ---------- redact ----------
const NAME_KEY = /^(?:name|fullName|full_name|firstName|first_name|lastName|last_name|claimantName|insuredName|driverName|ownerName|witnessName|contactName|reportedBy)$/i;
const PHONE_KEY = /^(?:phone|phoneNumber|mobile|cell|telephone|tel)$/i;
const EMAIL_KEY = /^(?:email|emailAddress)$/i;
const SSN_KEY = /^(?:ssn|socialSecurityNumber)$/i;
const MBI_KEY = /^(?:mbi|medicareId|medicareNumber)$/i;
const HEALTH_KEY = /^(?:injuryDescription|injuryDetails|injuriesDescription|injuryText|medicalNotes|medicalDetails|diagnosis|treatment)$/i;
const PLATE_KEY = /^(?:plate|licensePlate|license_plate|plateNumber|licencePlate|tag)$/i;

const MBI_C = 'AC-HJKMNP-RT-Y';
// Lookbehind pins the start to the beginning of a local-part run so scanning is linear, not quadratic.
const RE_EMAIL = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]{1,255}\.[A-Z]{2,}\b/gi;
const RE_SSN = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
const RE_MBI = new RegExp(`\\b[1-9]-?[${MBI_C}][${MBI_C}0-9]\\d-?[${MBI_C}][${MBI_C}0-9]\\d-?[${MBI_C}]{2}\\d{2}\\b`, 'g');
const RE_PHONE = /(?<![\w$])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/g;
// Whitespace runs are bounded ({0,3}) so a whitespace flood cannot backtrack quadratically.
const RE_PLATE_LABELED = /\b((?:license|licence)?[ \t]{0,3}(?:plate|tag)(?:[ \t]{0,3}(?:no\.?|number|#))?[ \t]{0,3}[:#-]?[ \t]{0,3})([A-Z0-9][A-Z0-9 -]{1,8}[A-Z0-9])\b/gi;
const RE_PLATE_BARE = /\b(?:[A-Z]{3}[ -]?\d{3,4}|\d[A-Z]{3}\d{3})\b/g;
const HONORIFIC = /\b(?:Mr|Mrs|Ms|Mx|Miss|Dr|Prof|Officer|Sgt|Det)\.?\s+((?:[A-Z][a-z'-]+)(?:\s+[A-Z][a-z'-]+){0,2})/g;
const LABELED_NAME = /\b(?:name|claimant|insured|policyholder|driver|owner|witness|passenger|reported by|contact|caller|adjuster)\b(?:\s+name)?\s*[:\-]\s*([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+){1,3})/gi;
// Labelled names (S5-AI-08): label (case-insensitive, colon optional) then Capitalised words. Every quantifier is bounded; no nesting.
const LABEL_NAME = /(?<!\b(?:shop|business|company|vendor|file|policy|plan|insurer|carrier)[ \t])\b((?:customer|claimant|insured|owner|driver|witness|contact|policyholder|name|cited|reported by|other driver)\b[ \t]{0,3}(:?)[ \t]{0,3})([A-Za-z][\w'-]*(?:[ \t]+[A-Za-z][\w'-]*){0,4})/gi;
const LABEL_STOP = new Set(['phone', 'tel', 'telephone', 'mobile', 'cell', 'email', 'address', 'policy', 'claim', 'vehicle', 'information', 'info', 'details', 'unit', 'party', 'and', 'the', 'was', 'is', 'of']);
/** Leading Capitalised words (max 4), stopping at labels like Phone or any non-name word. */
function labelledName(c) {
  const out = [];
  for (const w of c.split(/[ \t]+/)) {
    if (w.length > 30 || !/^[A-Z][A-Za-z'-]*$/.test(w) || LABEL_STOP.has(w.toLowerCase()) || out.length === 4) break;
    out.push(w);
  }
  return out.join(' ');
}
const INLINE_NAME = /\b(?:my name is|this is|I am|I'm)\s+([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+){1,3})/gi;
/** Keep only the leading Capitalised words of a captured candidate (max 3). */
function leadingName(c) {
  const out = [];
  for (const w of c.trim().split(/\s+/)) { if (!/^[A-Z][a-z'-]+$/.test(w) || out.length === 3) break; out.push(w); }
  return out.length >= 2 ? out.join(' ') : '';
}
const NAME_STOP = new Set(['unit', 'driver', 'party', 'vehicle', 'insured', 'other', 'sample', 'report', 'the', 'lakeside', 'county']);

/** Fresh redaction state: one per provider call so placeholders stay consistent. */
export function createRedactionState() {
  return { counters: {}, byValue: new Map(), map: {} };
}

function token(state, kind, original) {
  const key = `${kind}\u0000${String(original).toLowerCase().trim()}`;
  if (state.byValue.has(key)) return state.byValue.get(key);
  const n = (state.counters[kind] = (state.counters[kind] ?? 0) + 1);
  const t = `[${kind}_${n}]`;
  state.byValue.set(key, t);
  state.map[t] = original;
  return t;
}

const RE_PLACEHOLDER_LIKE = /\[(NAME|PHONE|EMAIL|SSN|MBI|PLATE|INJURY)_(\d+)\]/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function plainName(s) {
  const words = s.trim().split(/\s+/);
  return !NAME_STOP.has(words[0].toLowerCase());
}

/** Register a name (and its words, when 3+ chars) as known so every occurrence is replaced. */
function learnName(state, full) {
  const v = String(full).trim();
  if (v.length < 2) return;
  state.known ??= new Set();
  state.known.add(v);
  for (const w of v.split(/\s+/)) if (w.length >= 3 && /^[A-Za-z'-]+$/.test(w)) state.known.add(w);
}

/**
 * Redact PII from free text.
 * @param {string} text
 * @param {{state?: object, knownNames?: string[]}} [opts] share `state` across strings of one call
 * @returns {{text: string, map: Record<string,string>, state: object}} map is token -> original (keep local)
 */
export function redact(text, opts = {}) {
  const state = opts.state ?? createRedactionState();
  for (const n of opts.knownNames ?? []) learnName(state, n);
  let s = typeof text === 'string' ? text : text == null ? '' : String(text);
  // Input that already looks like one of our placeholders must not be restorable to a real value.
  s = s.replace(RE_PLACEHOLDER_LIKE, '($1_$2)');
  s = s.replace(RE_EMAIL, (m) => token(state, 'EMAIL', m));
  s = s.replace(RE_SSN, (m) => token(state, 'SSN', m));
  s = s.replace(RE_MBI, (m) => token(state, 'MBI', m));
  s = s.replace(RE_PHONE, (m) => token(state, 'PHONE', m));
  s = s.replace(RE_PLATE_LABELED, (m, lead, plate) => (/\d/.test(plate) ? `${lead}${token(state, 'PLATE', plate)}` : m));
  s = s.replace(RE_PLATE_BARE, (m) => token(state, 'PLATE', m));
  s = s.replace(HONORIFIC, (m, nm) => (plainName(nm) ? m.replace(nm, token(state, 'NAME', nm)) : m));
  s = s.replace(LABEL_NAME, (m, lead, colon, cand) => {
    const nm = labelledName(cand);
    if (!nm || !plainName(nm) || (!colon && !nm.includes(' '))) return m;
    return `${lead}${token(state, 'NAME', nm)}${m.slice(lead.length + nm.length)}`;
  });
  for (const re of [LABELED_NAME, INLINE_NAME]) {
    s = s.replace(re, (m, cand) => {
      const nm = leadingName(cand);
      return nm && plainName(nm) ? m.replace(nm, token(state, 'NAME', nm)) : m;
    });
  }
  for (const [t, orig] of Object.entries(state.map)) if (t.startsWith('[NAME_')) learnName(state, orig);
  if (state.known?.size) {
    const names = [...state.known].sort((a, b) => b.length - a.length);
    for (const nm of names) {
      const re = new RegExp(`(?<![\\w\\[])${escapeRe(nm)}(?![\\w\\]])`, 'g');
      s = s.replace(re, () => token(state, 'NAME', nm));
    }
  }
  return { text: s, map: { ...state.map }, state };
}

/** Collect values under PII-keyed fields so they are registered before text is scanned. */
function collectKnown(value, state) {
  if (Array.isArray(value)) { value.forEach((v) => collectKnown(v, state)); return; }
  if (!isObj(value)) return;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && NAME_KEY.test(k)) learnName(state, v);
    else collectKnown(v, state);
  }
}

/**
 * Redact every string of a structured input. Field-aware: values under name/phone/email/ssn/mbi/plate
 * keys are replaced wholesale; all other strings go through redact() with shared placeholders.
 * @returns {{value: any, map: Record<string,string>, count: number}}
 */
export function redactValue(value, opts = {}) {
  const state = opts.state ?? createRedactionState();
  collectKnown(value, state);
  const byKey = (key, s) => {
    if (NAME_KEY.test(key)) return token(state, 'NAME', s);
    if (PHONE_KEY.test(key)) return token(state, 'PHONE', s);
    if (EMAIL_KEY.test(key)) return token(state, 'EMAIL', s);
    if (SSN_KEY.test(key)) return token(state, 'SSN', s);
    if (MBI_KEY.test(key)) return token(state, 'MBI', s);
    if (PLATE_KEY.test(key)) return token(state, 'PLATE', s);
    if (HEALTH_KEY.test(key)) return token(state, 'INJURY', s); // health free text never leaves unredacted (data-protection.md row 7)
    return null;
  };
  const out = mapStrings(value, (s, key) => (s.trim() && byKey(key, s)) || redact(s, { state }).text);
  return { value: out, map: { ...state.map }, count: Object.keys(state.map).length };
}

/** Put original values back (local use only). Works on strings or structured values. */
export function restore(value, map) {
  const toks = Object.keys(map ?? {});
  if (!toks.length) return value;
  return mapStrings(value, (s) => s.replace(/\[(?:NAME|PHONE|EMAIL|SSN|MBI|PLATE|INJURY)_\d+\]/g, (t) => map[t] ?? t));
}

// ---------- output validation ----------
/**
 * Minimal JSON-schema check (type, enum, const, required, properties, items, minimum, maximum, minLength, maxLength, minItems, maxItems).
 * Extra properties are allowed. Returns a list of error strings; empty means valid.
 */
export function validateAgainst(schema, value, path = '$') {
  if (!schema || typeof schema !== 'object') return [];
  const errs = [];
  const types = schema.type === undefined ? null : [].concat(schema.type);
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  if (types) {
    const t = typeOf(value);
    const ok = types.some((x) => (x === 'number' ? t === 'number' && Number.isFinite(value) : x === t) || (x === 'integer' && Number.isInteger(value)));
    if (!ok) return [`${path}: expected ${types.join('|')}, got ${t}`];
  }
  if ('const' in schema && value !== schema.const) errs.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: not in enum`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: above maximum`);
  }
  if (typeof value === 'string') {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems} items`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validateAgainst(schema.items, v, `${path}[${i}]`)));
  if (isObj(value) && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${path}.${k}: required`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in value) errs.push(...validateAgainst(sub, value[k], `${path}.${k}`));
  }
  return errs;
}

/**
 * Validate a task output against src/ai/schemas.mjs.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateOutput(task, output) {
  const schema = schemaFor(task);
  if (!schema) return { valid: false, errors: [`unknown task '${task}'`] };
  const errors = validateAgainst(schema, output);
  return { valid: errors.length === 0, errors };
}

// ---------- guard ----------
/** @returns {boolean} true when the provider sends text off the machine (anything not explicitly local) */
export function isCloudProvider(provider) {
  const where = provider?.locality ?? provider?.kind;
  if (where) return String(where).toLowerCase() !== 'local';
  return String(provider?.name ?? '').toLowerCase() !== 'local';
}

/**
 * Wrap a provider (same interface: name, available(), run(task, input, opts)) with guardrails.
 * The wrapped run never throws; on a problem it returns the cascade's fallback signal
 * `{ refusal: true, error }`, so the cascade moves on to the next provider.
 *
 * @param {{name: string, kind?: string, locality?: string, available?: Function, run: Function}} provider
 * @param {string|object} [task] default task (optional; run() receives the task per call). May be the opts.
 * @param {object} [opts]
 * @param {number} [opts.maxChars=20000] total string budget per call
 * @param {'truncate'|'reject'} [opts.onOversize='truncate']
 * @param {boolean} [opts.forceRedact=false] redact PII for this provider even when it is local (cloud providers are always redacted);
 *   a per-call `runOpts.forceRedact` of true does the same
 * @param {boolean} [opts.restoreOutput=true] map placeholders back to originals in the returned output (local only)
 * @param {{record: Function}} [opts.log] inference log; invalid/failed calls are recorded
 * @param {Function} [opts.onGuard] called with the guard report for each call (tests, telemetry)
 */
export function guard(provider, task, opts = {}) {
  if (isObj(task)) { opts = task; task = undefined; }
  const cloud = isCloudProvider(provider);

  return {
    name: provider.name,
    kind: provider.kind,
    locality: cloud ? 'cloud' : 'local',
    guarded: true,
    inner: provider,
    available: provider.available ? (...a) => Promise.resolve().then(() => provider.available(...a)).catch(() => false) : undefined,
    async run(callTask, input, runOpts = {}) {
      const t = callTask ?? task;
      const report = { task: t, provider: provider.name, cloud, neutralised: 0, truncated: false, redacted: 0, valid: null, errors: [] };
      const done = (res, skipped, usage) => {
        opts.onGuard?.(report);
        if (skipped && opts.log) {
          try {
            opts.log.record(runOpts.tenantId, { task: t, provider: provider.name, model: res?.model, tier: runOpts.tier, input, claimId: runOpts.claimId, usage: { ...(usage ?? {}), skipped, guard: true } });
          } catch { /* telemetry must never break a claim flow */ }
        }
        return res;
      };
      try {
        if (!schemaFor(t)) { report.errors.push(`unknown task '${t}'`); return done({ refusal: true, error: 'unknown_task' }, 'guard_unknown_task'); }
        let safe = input ?? {};
        const maxChars = opts.maxChars ?? inputCapFor(t);
        // Cap first so the sanitizer only ever sees bounded input.
        const capped = capValue(safe, maxChars);
        report.truncated = capped.truncated;
        if (capped.truncated && opts.onOversize === 'reject') return done({ refusal: true, error: 'input_too_large' }, 'guard_input_too_large');
        safe = capped.value;
        report.neutralised = countInjections(JSON.stringify(safe));
        safe = sanitizeValue(safe);
        let map = {};
        const redactOn = cloud || opts.forceRedact === true || runOpts.forceRedact === true;
        if (redactOn) {
          const r = redactValue(safe);
          safe = r.value; map = r.map; report.redacted = r.count;
        }
        const { forceRedact: _f, ...innerOpts } = runOpts;
        const res = await provider.run(t, safe, innerOpts);
        if (!res || res.refusal) return done(res && typeof res === 'object' ? res : { refusal: true, error: 'empty' }, null);
        const v = validateOutput(t, res.output);
        const conf = typeof res.confidence === 'number' && Number.isFinite(res.confidence) && res.confidence >= 0 && res.confidence <= 1;
        report.valid = v.valid && conf;
        if (!report.valid) {
          report.errors = conf ? v.errors : [...v.errors, '$.confidence: must be a number in [0,1]'];
          return done({ refusal: true, error: 'invalid_output', model: res.model, ...(res.usage ? { usage: res.usage } : {}) }, 'guard_invalid_output', res.usage);
        }
        const out = redactOn && report.redacted ? { ...res, output: restore(res.output, map), explanation: restore(res.explanation ?? '', map) } : res;
        return done(opts.restoreOutput === false ? res : out, null);
      } catch (e) {
        report.errors.push(String(e?.message ?? e).slice(0, 120));
        const usage = e?.usage && typeof e.usage === 'object' ? e.usage : undefined;
        return done({ refusal: true, error: 'provider_error', ...(usage ? { usage } : {}) }, 'guard_provider_error', usage);
      }
    },
  };
}

/**
 * Guard a whole {name: provider} map. Helper for wiring into createAi({ providers }) without editing the cascade.
 * @param {Record<string, object>} providers @param {object} [opts] guard opts
 */
export function guardProviders(providers, opts = {}) {
  return Object.fromEntries(Object.entries(providers).map(([k, p]) => [k, p ? guard(p, undefined, opts) : p]));
}
