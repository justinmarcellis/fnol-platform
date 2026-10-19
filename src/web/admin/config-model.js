// Pure helpers for the admin console: JSON-pointer access, list edits, value coercion,
// validation-report mapping, condition summaries, history and KPI shaping. No DOM, no I/O.

/** Deep clone of JSON data. @param {any} v */
export function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

/** Split a JSON pointer ('/a/0/b') or dotted path into segments. @param {string} p */
export function parsePointer(p) {
  if (Array.isArray(p)) return p.map(String);
  const s = String(p ?? '');
  if (s === '' || s === '/') return [];
  if (s.startsWith('/')) return s.slice(1).split('/').map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'));
  return s.split('.');
}

/** Build a JSON pointer from segments. @param {Array<string|number>} segs */
export function toPointer(segs) {
  return segs.length ? `/${segs.map((x) => String(x).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}` : '';
}

/** Read a value by pointer. @param {any} obj @param {string} pointer */
export function getAt(obj, pointer) {
  let cur = obj;
  for (const k of parsePointer(pointer)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Set (or with undefined, delete) a value by pointer, creating containers. Mutates and returns obj.
 * @param {any} obj @param {string} pointer @param {any} value
 */
export function setAt(obj, pointer, value) {
  const segs = parsePointer(pointer);
  if (!segs.length) throw new Error('Cannot set the document root');
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = /^\d+$/.test(segs[i + 1]) ? [] : {};
    cur = cur[k];
  }
  const last = segs[segs.length - 1];
  if (value === undefined) {
    if (Array.isArray(cur)) cur.splice(Number(last), 1); else delete cur[last];
  } else cur[last] = value;
  return obj;
}

/** Append an item to the array at pointer. @returns {number} new index */
export function addItem(obj, pointer, item) {
  let arr = getAt(obj, pointer);
  if (!Array.isArray(arr)) { setAt(obj, pointer, []); arr = getAt(obj, pointer); }
  arr.push(item);
  return arr.length - 1;
}

/** Remove the item at index. @returns {boolean} */
export function removeItem(obj, pointer, index) {
  const arr = getAt(obj, pointer);
  if (!Array.isArray(arr) || index < 0 || index >= arr.length) return false;
  arr.splice(index, 1);
  return true;
}

/** Move an item by delta positions (clamped). @returns {boolean} true if moved */
export function moveItem(obj, pointer, index, delta) {
  const arr = getAt(obj, pointer);
  const to = index + delta;
  if (!Array.isArray(arr) || index < 0 || index >= arr.length || to < 0 || to >= arr.length) return false;
  const [it] = arr.splice(index, 1);
  arr.splice(to, 0, it);
  return true;
}

/** Comma-separated text to a trimmed, de-duplicated list. @param {string} text */
export function parseCsv(text) {
  const out = [];
  for (const p of String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) if (!out.includes(p)) out.push(p);
  return out;
}

/** Locale tag check (BCP 47 subset used by the contract). */
export const isLocale = (s) => /^[a-z]{2}(-[A-Z]{2})?$/.test(s);

/**
 * Coerce raw form input into the stored value.
 * kinds: text, number, bool, csv, json. Empty text/number/json/csv yields undefined (key removed).
 * json returns {error} on a syntax problem.
 * @param {'text'|'number'|'bool'|'csv'|'json'|'int'} kind @param {any} raw
 * @returns {{value?: any, error?: string}}
 */
export function coerce(kind, raw) {
  switch (kind) {
    case 'bool': return { value: raw === true || raw === 'true' || raw === 'on' };
    case 'number':
    case 'int': {
      const s = String(raw ?? '').trim();
      if (s === '') return { value: undefined };
      const n = Number(s);
      if (!Number.isFinite(n)) return { error: 'Enter a number.' };
      if (kind === 'int' && !Number.isInteger(n)) return { error: 'Enter a whole number.' };
      return { value: n };
    }
    case 'csv': { const l = parseCsv(raw); return { value: l.length ? l : undefined }; }
    case 'json': {
      const s = String(raw ?? '').trim();
      if (s === '') return { value: undefined };
      try { return { value: JSON.parse(s) }; } catch (e) { return { error: `Invalid JSON: ${e.message}` }; }
    }
    default: { const s = String(raw ?? ''); return { value: s === '' ? undefined : s }; }
  }
}

/** Pretty JSON text for a textarea. @param {any} v */
export function toJsonText(v) { return v === undefined ? '' : JSON.stringify(v, null, 2); }

/** Text of an I18nText for a locale: plain strings count as 'en'. */
export function i18nGet(text, locale) {
  if (typeof text === 'string') return locale === 'en' ? text : '';
  return text && typeof text === 'object' ? (text[locale] ?? '') : '';
}

/**
 * Return a new I18nText with the locale set. Stays a plain string while only 'en' is used;
 * an empty value removes the locale; an empty result is undefined.
 */
export function i18nSet(text, locale, value) {
  const map = typeof text === 'string' ? { en: text } : { ...(text && typeof text === 'object' ? text : {}) };
  if (value === '' || value == null) delete map[locale]; else map[locale] = value;
  const keys = Object.keys(map);
  if (!keys.length) return undefined;
  if (keys.length === 1 && keys[0] === 'en') return map.en;
  return map;
}

/** Locales the editor shows: config.locales, falling back to ['en']. */
export function configLocales(cfg) {
  const l = Array.isArray(cfg?.locales) && cfg.locales.length ? cfg.locales : ['en'];
  return l.filter(isLocale);
}

// ---- defaults for new items (valid against the contract once filled in)
export const newLob = () => ({ id: 'new_lob', enabled: false, label: 'New line of business' });
export const newQuestionSet = (lob = 'personal_auto') => ({ id: `${lob}-set`, lob, version: 1, questions: [newQuestion('question_1')] });
export const newQuestion = (id = 'new_question') => ({ id, text: 'New question', type: 'text', required: false });
export const newRule = () => ({ id: 'RT-NEW-01', name: 'New rule', stage: 'routing', priority: 100, enabled: true, when: true, then: [{ type: 'add_flag', flag: 'review' }] });
export const newTimer = (state = 'WI') => ({ id: `${state.toLowerCase()}-ack`, state, kind: 'acknowledge', duration: { value: 1, unit: 'days' }, startOn: 'claim.reported' });

/** Human summary of a condition (FNOL condition language v1). @param {any} c */
export function describeCondition(c) {
  if (c === undefined || c === null) return 'always';
  if (typeof c === 'boolean') return c ? 'always' : 'never';
  if (typeof c !== 'object') return 'invalid condition';
  if (Array.isArray(c.all)) return `(${c.all.map(describeCondition).join(' and ')})`;
  if (Array.isArray(c.any)) return `(${c.any.map(describeCondition).join(' or ')})`;
  if (c.not !== undefined) return `not ${describeCondition(c.not)}`;
  if (typeof c.fact === 'string' && typeof c.op === 'string') {
    const v = c.value === undefined ? '' : ` ${JSON.stringify(c.value)}`;
    return `${c.fact} ${c.op}${v}`;
  }
  return 'invalid condition';
}

/** Console section a JSON pointer belongs to (branding, questions, rules, timers, webhooks, ai). @param {string} pointer */
export function sectionOf(pointer) {
  const top = parsePointer(pointer)[0];
  if (top === 'branding' || top === 'displayName' || top === 'claimNumberPrefix' || top === 'timeZone' || top === 'locales') return 'branding';
  if (top === 'lobs' || top === 'questionSets') return 'questions';
  if (top === 'rules' || top === 'queues' || top === 'fastTrack') return 'rules';
  if (top === 'timers' || top === 'holidays') return 'timers';
  if (top === 'notifications' || top === 'integrations') return 'webhooks';
  if (top === 'ai') return 'ai';
  return 'other';
}

/**
 * Normalise a ValidationReport (or a 422 body) for display.
 * @returns {{valid:boolean, errors:Array<{path:string,code:string,message:string,section:string}>, warnings:Array, bySection:Record<string,number>}}
 */
export function normalizeReport(report) {
  const errors = (Array.isArray(report?.errors) ? report.errors : []).map((e) => ({
    path: String(e.path ?? ''), code: String(e.code ?? 'invalid'), message: String(e.message ?? 'Invalid value'), section: sectionOf(e.path ?? ''),
  }));
  const warnings = (Array.isArray(report?.warnings) ? report.warnings : []).map((w) => ({ path: String(w.path ?? ''), message: String(w.message ?? '') }));
  const bySection = {};
  for (const e of errors) bySection[e.section] = (bySection[e.section] ?? 0) + 1;
  return { valid: report?.valid === true && errors.length === 0, errors, warnings, bySection };
}

/** Errors that apply to a pointer (exact), or to a field below/above it. */
export function errorsFor(report, pointer) {
  return (report?.errors ?? []).filter((e) => e.path === pointer);
}

/** Pointer prefix match: error at /a/b/c is also relevant to a field at /a/b. */
export function errorsUnder(report, pointer) {
  return (report?.errors ?? []).filter((e) => e.path === pointer || e.path.startsWith(`${pointer}/`));
}

/** Parse an ETag / If-Match value to a version number, or null. @param {string|null|undefined} etag */
export function parseEtag(etag) {
  if (etag == null) return null;
  const n = Number(String(etag).replace(/^W\//, '').replace(/"/g, ''));
  return Number.isInteger(n) ? n : null;
}

/** If-Match header value for a config version. */
export const ifMatch = (version) => `"${version}"`;

/** Top-level sections that differ between two configs (ignores version/updatedAt/updatedBy). */
export function changedSections(before, after) {
  const skip = new Set(['version', 'updatedAt', 'updatedBy']);
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => !skip.has(k) && JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])).sort();
}

/** True when the draft differs from the saved config. */
export const isDirty = (saved, draft) => changedSections(saved, draft).length > 0;

/**
 * Normalise version history from either shape: config versions ({items:[{version,actor,createdAt}]}),
 * or audit entries (action tenant.config.updated with details.version). Newest first.
 */
export function normalizeHistory(body) {
  const items = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
  const rows = [];
  for (const it of items) {
    if (it.action && it.action !== 'tenant.config.updated' && it.action !== 'tenant.config.put') continue;
    const version = it.version ?? it.details?.version;
    if (!Number.isInteger(version)) continue;
    rows.push({
      version,
      actor: it.actor ?? it.updatedBy ?? 'unknown',
      at: it.createdAt ?? it.created_at ?? it.at ?? it.ts ?? it.timestamp ?? '',
      changed: it.changedSections ?? it.details?.changedSections ?? [],
    });
  }
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.version) ? false : seen.add(r.version))).sort((a, b) => b.version - a.version);
}

/** Flatten a KPI payload into label/value rows (objects with value/numerator fields become one row). */
export function flattenKpis(body, prefix = '') {
  const rows = [];
  if (body == null) return rows;
  if (typeof body !== 'object') return [{ key: prefix, value: String(body) }];
  if (Array.isArray(body)) {
    body.forEach((v, i) => rows.push(...flattenKpis(v, `${prefix}[${i}]`)));
    return rows;
  }
  for (const [k, v] of Object.entries(body)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) rows.push({ key, value: 'n/a' });
    else if (typeof v === 'object') rows.push(...flattenKpis(v, key));
    else rows.push({ key, value: String(v) });
  }
  return rows;
}

/** Short single-line preview of a JSON value for the diff table. */
export function previewValue(v, max = 80) {
  if (v === undefined) return '(not set)';
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}

/**
 * Field-level differences between the saved config and the draft, for the save preview.
 * Arrays and objects are walked; version/updatedAt/updatedBy are ignored.
 * @returns {Array<{path:string, kind:'added'|'removed'|'changed', before:any, after:any, section:string}>}
 */
export function diffConfig(before, after, limit = 500) {
  const out = [];
  const skip = new Set(['/version', '/updatedAt', '/updatedBy']);
  const isObj = (v) => v !== null && typeof v === 'object';
  const walk = (a, b, ptr) => {
    if (out.length >= limit || skip.has(ptr)) return;
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
      const keys = Array.isArray(a) ? Array.from({ length: Math.max(a.length, b.length) }, (_, i) => String(i)) : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const k of keys) walk(a[k], b[k], `${ptr}/${k}`);
      return;
    }
    out.push({ path: ptr, kind: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed', before: a, after: b, section: sectionOf(ptr) });
  };
  walk(before ?? {}, after ?? {}, '');
  return out;
}

const KPI_UNITS = { ratio: (v) => `${Math.round(v * 1000) / 10}%`, minutes: (v) => (v >= 120 ? `${Math.round(v / 6) / 10} h` : `${Math.round(v * 10) / 10} min`), count: (v) => String(Math.round(v)) };

/** Format one KPI value for a stat tile ("n/a" when null). */
export function formatKpiValue(value, unit) {
  if (!Number.isFinite(value)) return 'n/a';
  return (KPI_UNITS[unit] ?? String)(value);
}

/** Stat tiles from a GET /kpis body ({period, metrics:[...]}); falls back to flattened rows. */
export function kpiTiles(body) {
  const list = Array.isArray(body?.metrics) ? body.metrics : [];
  return list.filter((m) => m && typeof m === 'object' && m.id).map((m) => ({
    id: String(m.id), label: String(m.label ?? m.id), value: formatKpiValue(m.value, m.unit), driver: m.valueDriver ?? '',
    hint: m.note ?? m.definition ?? '', detail: Number.isFinite(m.numerator) && Number.isFinite(m.denominator) ? `${m.numerator} of ${m.denominator}` : '',
  }));
}
