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
/** A new question starts without text or type, so validation blocks a save until both are filled in (ADMIN-9). */
export const newQuestion = (id = 'new_question', order) => ({ id, text: '', type: '', required: false, ...(Number.isInteger(order) ? { order } : {}) });
export const newRule = () => ({ id: 'RT-NEW-01', name: 'New rule', stage: 'routing', priority: 100, enabled: true, when: true, then: [{ type: 'add_flag', flag: 'review' }] });
export const newTimer = (state = 'WI', n = 1) => ({ id: `${state.toUpperCase()}-TIMER-${n}`, state, kind: 'acknowledge', duration: { value: 1, unit: 'days' }, startOn: 'claim.reported' });
export const newQueue = (n = 1) => ({ id: `queue_${n}`, label: `New queue ${n}`, adjusters: [], assignment: 'round_robin' });

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
  if (top === 'rules' || top === 'queues' || top === 'fastTrack' || top === 'defaultQueue' || top === 'severityBands') return 'rules';
  if (top === 'timers' || top === 'holidays') return 'timers';
  if (top === 'notifications' || top === 'integrations') return 'webhooks';
  if (top === 'ai') return 'ai';
  if (top === 'security') return 'security';
  return 'other';
}

/**
 * Normalise a ValidationReport (or a 422 body) for display. Messages are rewritten in plain language and
 * each problem gets a field label (cfg, when given, names items by id); the server text is kept as detail.
 * @returns {{valid:boolean, errors:Array<{path:string,code:string,message:string,section:string}>, warnings:Array, bySection:Record<string,number>}}
 */
export function normalizeReport(report, cfg) {
  const errors = (Array.isArray(report?.errors) ? report.errors : []).map((e) => {
    const path = String(e.path ?? '');
    const raw = { path, code: e.code == null ? undefined : String(e.code), message: String(e.message ?? 'Invalid value') };
    return { path, code: raw.code ?? 'invalid', message: friendlyMessage(raw, cfg), detail: raw.message, label: labelFor(path, cfg), section: sectionOf(path) };
  });
  const warnings = (Array.isArray(report?.warnings) ? report.warnings : []).map((w) => {
    const path = String(w.path ?? '');
    return { path, message: sentence(String(w.message ?? '')), label: labelFor(path, cfg), section: sectionOf(path) };
  });
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
    const actor = it.actor ?? it.updatedBy ?? 'unknown';
    const keys = it.changedKeys ?? it.details?.changedKeys ?? [];
    const sections = it.changedSections ?? it.details?.changedSections ?? [];
    const source = it.source ?? (actor === 'boot' ? 'tenant_file' : '');
    let changed = changedLabels(keys.length ? keys : sections);
    if (!changed.length && source === 'tenant_file') changed = [version === 1 ? 'Initial configuration from the tenant file' : 'Reloaded from the tenant file'];
    rows.push({
      version,
      actor,
      actorName: it.actorName ?? it.details?.actorName ?? humanizeActor(actor),
      at: it.createdAt ?? it.created_at ?? it.at ?? it.ts ?? it.timestamp ?? '',
      changed,
      source,
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
 * Lists whose run order comes from a field rather than array position: intake sorts questions by `order`
 * (ties by array position) and the rules engine sorts rules by `priority` (ties by id).
 * @param {string} pointer JSON pointer of the list
 * @returns {{key:string, missing:number, tie:'index'|'id'}|null}
 */
export function orderedListSpec(pointer) {
  const segs = parsePointer(pointer);
  if (segs.length === 3 && segs[0] === 'questionSets' && /^\d+$/.test(segs[1]) && segs[2] === 'questions') return { key: 'order', missing: 1e6, tie: 'index' };
  if (segs.length === 1 && segs[0] === 'rules') return { key: 'priority', missing: 100, tie: 'id', group: 'stage', groups: RUN_STAGES };
  return null;
}

/** Rule stages in the order the engine runs them; priority only orders rules within one stage. */
export const RUN_STAGES = ['intake', 'triage', 'routing', 'post_routing'];
const groupRank = (item, spec) => { const i = spec.groups.indexOf(item?.[spec.group]); return i < 0 ? spec.groups.length : i; };
const sameGroup = (a, b, spec) => !spec.group || groupRank(a, spec) === groupRank(b, spec);

const effOrder = (item, spec) => (Number.isFinite(item?.[spec.key]) ? item[spec.key] : spec.missing);

/**
 * Array indices of a list in the order the platform uses it (spec null: array order).
 * @param {object[]} list @param {object|null} spec from orderedListSpec
 * @returns {number[]}
 */
export function runSequence(list, spec) {
  const idx = (Array.isArray(list) ? list : []).map((_, i) => i);
  if (!spec) return idx;
  return idx.sort((a, b) => (spec.group ? groupRank(list[a], spec) - groupRank(list[b], spec) : 0)
    || effOrder(list[a], spec) - effOrder(list[b], spec)
    || (spec.tie === 'id' ? String(list[a]?.id ?? '').localeCompare(String(list[b]?.id ?? '')) : a - b));
}

/**
 * Move the item at array index `index` one step earlier (delta -1) or later (+1) in its run order
 * (rules only within their stage).
 * Ordered lists change the order/priority values (the fewest needed) so the platform really asks or runs
 * the item in its new place; other lists move the array element. Mutates obj.
 * @returns {boolean} true when something moved
 */
export function moveInRunOrder(obj, pointer, index, delta) {
  const list = getAt(obj, pointer);
  const spec = orderedListSpec(pointer);
  if (!spec) return moveItem(obj, pointer, index, delta);
  if (!Array.isArray(list)) return false;
  const seq = runSequence(list, spec);
  const p = seq.indexOf(index);
  const q = p + delta;
  if (p < 0 || q < 0 || q >= seq.length) return false;
  const desired = [...seq];
  [desired[p], desired[q]] = [desired[q], desired[p]];
  const want = desired.map((i) => list[i]);
  const a = list[seq[p]]; const b = list[seq[q]];
  if (!sameGroup(a, b, spec)) return false; // a rule cannot run before another stage
  const va = effOrder(a, spec); const vb = effOrder(b, spec);
  const same = () => runSequence(list, spec).map((i) => list[i]).every((it, k) => it === want[k]);
  if (va !== vb) { a[spec.key] = vb; b[spec.key] = va; } else if (spec.tie === 'index') {
    [list[seq[p]], list[seq[q]]] = [list[seq[q]], list[seq[p]]];
  } else a[spec.key] = va + delta;
  if (same()) return true;
  // Fallback: renumber along the wanted order, keeping every value that already increases.
  let prev = -Infinity;
  for (const it of want.filter((x) => sameGroup(x, a, spec))) {
    const v = effOrder(it, spec);
    if (v > prev) prev = v; else { prev += 1; it[spec.key] = prev; }
  }
  return true;
}

const isObj = (v) => v !== null && typeof v === 'object';
const idList = (arr) => Array.isArray(arr) && arr.length > 0 && arr.every((x) => isObj(x) && !Array.isArray(x) && typeof x.id === 'string');

/** Longest common subsequence of two id lists, as a Set of the ids kept in place. */
function lcsKept(a, b) {
  const m = a.length; const n = b.length;
  const t = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const kept = new Set();
  for (let i = 0, j = 0; i < m && j < n;) {
    if (a[i] === b[j]) { kept.add(a[i]); i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) i++; else j++;
  }
  return kept;
}

/**
 * Field-level differences between the saved config and the draft, for the save preview.
 * Lists of items with ids are matched by id, so a reorder shows as one 'moved' row per item that moved
 * (in run order: question `order`, rule `priority`) instead of field-by-field swaps; a new or removed item
 * is one row. version/updatedAt/updatedBy are ignored. Each row carries a readable label.
 * @returns {Array<{path:string, kind:'added'|'removed'|'changed'|'moved', before:any, after:any, section:string, label:string}>}
 */
export function diffConfig(before, after, limit = 500) {
  const out = [];
  const skip = new Set(['/version', '/updatedAt', '/updatedBy']);
  const push = (row, cfg) => { if (out.length < limit) out.push({ ...row, section: sectionOf(row.path), label: labelFor(row.path, cfg) }); };
  const walk = (a, b, ptr, skipKey) => {
    if (out.length >= limit || skip.has(ptr)) return;
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (idList(a) && idList(b)) { walkList(a, b, ptr); return; }
    if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
      const keys = Array.isArray(a) ? Array.from({ length: Math.max(a.length, b.length) }, (_, i) => String(i)) : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const k of keys) if (k !== skipKey) walk(a[k], b[k], `${ptr}/${k}`);
      return;
    }
    push({ path: ptr, kind: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed', before: a, after: b }, b === undefined ? before : after);
  };
  const walkList = (a, b, ptr) => {
    const spec = orderedListSpec(ptr);
    const usedA = new Set();
    const pairs = []; // [ia, ib]
    const unmatchedB = [];
    b.forEach((it, ib) => {
      const ia = a.findIndex((x, i) => !usedA.has(i) && x.id === it.id);
      if (ia >= 0) { usedA.add(ia); pairs.push([ia, ib]); } else unmatchedB.push(ib);
    });
    const unmatchedA = a.map((_, i) => i).filter((i) => !usedA.has(i));
    // An item whose id was edited pairs with a leftover item, so it reads as a change, not remove plus add.
    while (unmatchedA.length && unmatchedB.length) pairs.push([unmatchedA.shift(), unmatchedB.shift()]);
    const tokenA = new Map(pairs.map(([ia], k) => [ia, k]));
    const tokenB = new Map(pairs.map(([, ib], k) => [ib, k]));
    const seqA = runSequence(a, spec).filter((i) => tokenA.has(i)).map((i) => tokenA.get(i));
    const seqB = runSequence(b, spec).filter((i) => tokenB.has(i)).map((i) => tokenB.get(i));
    const kept = lcsKept(seqA, seqB);
    // When the run order changed, order/priority edits are what moved items; the 'moved' rows describe them.
    const anyMoved = pairs.some(([, ib]) => !kept.has(tokenB.get(ib)));
    for (const [ia, ib] of pairs) {
      const k = tokenB.get(ib);
      const moved = !kept.has(k);
      walk(a[ia], b[ib], `${ptr}/${ib}`, spec && anyMoved ? spec.key : undefined);
      if (!moved) continue;
      const posB = seqB.indexOf(k);
      const prevTok = seqB[posB - 1];
      let prevItem = prevTok === undefined ? null : b[pairs[prevTok][1]];
      if (spec && prevItem && !sameGroup(prevItem, b[ib], spec)) prevItem = null;
      const posA = seqA.indexOf(k);
      const prevATok = seqA[posA - 1];
      let prevAItem = prevATok === undefined ? null : a[pairs[prevATok][0]];
      if (spec && prevAItem && !sameGroup(prevAItem, a[ia], spec)) prevAItem = null;
      push({
        path: `${ptr}/${ib}`, kind: 'moved', id: b[ib].id,
        before: prevAItem ? `after ${prevAItem.id}` : 'first',
        after: prevItem ? `after ${prevItem.id}` : 'first',
      }, after);
    }
    for (const ib of unmatchedB) push({ path: `${ptr}/${ib}`, kind: 'added', before: undefined, after: b[ib] }, after);
    for (const ia of unmatchedA) push({ path: `${ptr}/${ia}`, kind: 'removed', before: a[ia], after: undefined }, before);
  };
  walk(before ?? {}, after ?? {}, '');
  return out;
}

/** One-line description of a diff row, e.g. 'loss_date moved after loss_time'. */
export function describeChange(c) {
  if (c.kind === 'moved') return `${c.id} moved ${c.after === 'first' ? 'to the start' : c.after}`;  // e.g. 'loss_date moved after loss_time'
  if (c.kind === 'added' && isObj(c.after) && typeof c.after.id === 'string') return `Added ${c.after.id}`;
  if (c.kind === 'removed' && isObj(c.before) && typeof c.before.id === 'string') return `Removed ${c.before.id}`;
  return '';
}

/** Readable value for the diff table: item summaries instead of raw JSON objects. */
export function displayValue(v, max = 80) {
  if (isObj(v) && !Array.isArray(v) && typeof v.id === 'string') {
    const text = typeof v.text === 'string' ? v.text : v.text?.en ?? (typeof v.label === 'string' ? v.label : v.label?.en) ?? v.name ?? '';
    return previewValue(text ? `${v.id}: ${text}` : `${v.id} (no text yet)`, max);
  }
  return previewValue(v, max);
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
    id: String(m.id), label: String(m.label ?? m.id), value: formatKpiValue(m.value, m.unit),
    hint: m.note ?? m.definition ?? '', detail: Number.isFinite(m.numerator) && Number.isFinite(m.denominator) ? `${m.numerator} of ${m.denominator}` : '',
  }));
}

// ---- readable names (S6-BUG-04: no raw pointers, codes or regexes in front of the admin)

/** Top-level config keys as the admin knows them. */
export const KEY_LABEL = {
  displayName: 'Identity', claimNumberPrefix: 'Identity', timeZone: 'Identity', locales: 'Languages', branding: 'Branding',
  lobs: 'Lines of business', questionSets: 'Intake questions', rules: 'Routing rules', queues: 'Queues and adjusters',
  defaultQueue: 'Queues and adjusters', fastTrack: 'Fast track', severityBands: 'Severity bands', timers: 'Regulatory timers',
  holidays: 'Holidays', notifications: 'Notifications', integrations: 'Integrations', ai: 'AI settings', security: 'Security and data',
  evidence: 'Evidence', seedVersion: 'Tenant file version', other: 'Identity or languages',
};

/** Field names for leaf keys; anything else is sentence-cased from camelCase. */
export const FIELD_LABEL = {
  displayName: 'Display name', claimNumberPrefix: 'Claim number prefix', timeZone: 'Time zone', locales: 'Locales',
  primaryColor: 'Primary color', accentColor: 'Accent color', fontFamily: 'Font family', logoUrl: 'Logo path', supportPhone: 'Support phone',
  supportEmail: 'Support email', legalFooter: 'Legal footer', fraudWarning: 'Fraud warning', id: 'Id', label: 'Label', enabled: 'Enabled',
  acordLobCd: 'ACORD LOB code', states: 'States', lossTypes: 'Loss types', channels: 'Channels', lob: 'Line of business', version: 'Set version',
  text: 'Question text', help: 'Help text', type: 'Type', required: 'Required', requiredIf: 'Required if (condition)', showIf: 'Show if (condition)',
  options: 'Options', validation: 'Validation', mapsTo: 'Saved to field', aiAssist: 'AI assist', order: 'Order', section: 'Section', pii: 'Personal data',
  name: 'Name', stage: 'Stage', priority: 'Priority', when: 'When (condition)', then: 'Then (actions)', stopOnMatch: 'Stop on match', appliesTo: 'Applies to',
  maxSeverity: 'Maximum severity', maxFraudScore: 'Maximum fraud score', maxEstimate: 'Maximum estimate', amount: 'Amount', queue: 'Queue',
  skills: 'Skills', adjusters: 'Adjusters', assignment: 'Assignment', slaHours: 'SLA (hours)', moderate: 'Moderate from', major: 'Major from', severe: 'Severe from',
  kind: 'Kind', duration: 'Duration', value: 'Value', unit: 'Unit', startOn: 'Starts on event', stopOn: 'Stops on', warnBefore: 'Warn before', onBreach: 'On breach (actions)',
  citation: 'Citation', claimant: 'Claimant notices', internal: 'Internal notices', webhooks: 'Webhooks', onEvents: 'Events', emails: 'Email addresses',
  allowedHosts: 'Allowed hosts', signingAlgorithm: 'Signing algorithm', includePii: 'Include personal data', policyPort: 'Policy system', claimsPort: 'Claims system',
  adapter: 'Adapter', settings: 'Settings', pushOn: 'Push on', provider: 'Provider', region: 'Region', maxTokensPerClaim: 'Token budget per claim',
  redactPiiBeforeModel: 'Redact personal data', humanConfirmRequired: 'Human confirmation', cascade: 'Provider cascade', tasks: 'Tasks', threshold: 'Confidence threshold',
  minConfidence: 'Minimum confidence', model: 'Model', piiKeyRef: 'Data key reference', sessionTtlMinutes: 'Session length (minutes)', dataRetentionDays: 'Data retention (days)',
  toStatus: 'To status', taskType: 'Task type', event: 'Event',
};

/** JSON-valued fields: the label stops here instead of descending into the JSON. */
const JSON_FIELDS = new Set(['when', 'then', 'showIf', 'requiredIf', 'options', 'cascade', 'onBreach', 'settings', 'validation', 'appliesTo', 'fraudWarning', 'lossTypes', 'evidence']);

/** Sentence case for a camelCase or snake_case key: 'maxTokensPerClaim' -> 'Max tokens per claim'. */
export function humanizeKey(k) {
  const s = String(k ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

const textOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? v.en ?? Object.values(v)[0] ?? '' : '');

/** Readable name of a question set id: 'commauto-general' -> 'Commercial auto, general'. */
export function setTitle(id) {
  const words = { commauto: 'Commercial auto', auto: 'Auto', home: 'Home', homeowners: 'Homeowners', glass: 'glass', general: 'general', property: 'Property' };
  const parts = String(id ?? '').split(/[-_]+/).filter(Boolean);
  if (!parts.length) return 'Untitled set';
  const [first, ...rest] = parts;
  const head = words[first] ?? humanizeKey(first);
  return rest.length ? `${head}, ${rest.map((r) => (words[r] ?? r).toLowerCase()).join(' ')}` : head;
}

/** Line-of-business label for an id (from the config), or a sentence-cased id. */
export function lobLabel(cfg, id) {
  const l = (cfg?.lobs ?? []).find((x) => x?.id === id);
  return textOf(l?.label) || humanizeKey(id);
}

/**
 * Readable label for a JSON pointer, e.g. '/branding/primaryColor' -> 'Branding > Primary color',
 * '/questionSets/2/questions/0/required' -> 'Intake questions > Commercial auto, general > Question loss_date > Required'.
 * @param {string} pointer @param {object} [cfg] config used to name list items
 */
export function labelFor(pointer, cfg) {
  const segs = parsePointer(pointer);
  if (!segs.length) return 'Whole configuration';
  const parts = [KEY_LABEL[segs[0]] ?? humanizeKey(segs[0])];
  if (['displayName', 'claimNumberPrefix', 'timeZone'].includes(segs[0])) parts.push(FIELD_LABEL[segs[0]]);
  let node = cfg?.[segs[0]];
  for (let i = 1; i < segs.length; i++) {
    const k = segs[i]; const parent = segs[i - 1];
    const item = Array.isArray(node) && /^\d+$/.test(k) ? node[Number(k)] : undefined;
    if (/^\d+$/.test(k)) {
      const n = Number(k) + 1;
      if (parent === 'questionSets') parts.push(item?.id ? setTitle(item.id) : `Question set ${n}`);
      else if (parent === 'questions') parts.push(item?.id ? `Question ${item.id}` : `Question ${n}`);
      else if (parent === 'rules') parts.push(item?.id ? `Rule ${item.id}` : `Rule ${n}`);
      else if (parent === 'timers') parts.push(item?.id ? `Timer ${item.id}` : `Timer ${n}`);
      else if (parent === 'lobs') parts.push(item ? textOf(item.label) || item.id || `Line ${n}` : `Line ${n}`);
      else if (parent === 'queues') parts.push(item ? textOf(item.label) || item.id || `Queue ${n}` : `Queue ${n}`);
      else parts.push(`Item ${n}`);
    } else if (k === 'questions' && segs[i - 2] === 'questionSets') { /* the set name already says it */ } else if (parent === 'tasks' && segs[i - 2] === 'ai') parts.push(humanizeKey(k));
    else if (parent === 'legalFooter' || parent === 'label' || parent === 'text') parts.push(k.toUpperCase());
    else parts.push(FIELD_LABEL[k] ?? humanizeKey(k));
    if (JSON_FIELDS.has(k)) break;
    node = item ?? (node && typeof node === 'object' ? node[k] : undefined);
  }
  return parts.join(' > ');
}

/** Section names for the history table, from changed top-level keys (or the event's section names). */
export function changedLabels(keys) {
  return [...new Set((Array.isArray(keys) ? keys : []).map((k) => KEY_LABEL[k] ?? humanizeKey(k)))];
}

/** Readable fallback for an actor id: 'dev-aurelia-mutual-carrier-admin' -> 'Carrier admin'. */
export function humanizeActor(actor) {
  const a = String(actor ?? '').trim();
  if (!a || a === 'unknown') return 'Unknown';
  if (a === 'boot') return 'System (tenant file)';
  if (a === 'system') return 'System';
  const role = /(carrier-admin|tenant-admin|supervisor|auditor|integration)$/.exec(a)?.[1];
  return role ? humanizeKey(role) : a;
}

/** Capital first letter and a closing full stop. */
export function sentence(t) {
  const s = String(t ?? '').trim();
  if (!s) return '';
  const c = s[0].toUpperCase() + s.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
}

const PATTERN_HINT = {
  claimNumberPrefix: 'Use 2 to 5 capital letters, for example AUR.',
  primaryColor: 'Enter a six-digit hex colour such as #0b5cad.',
  accentColor: 'Enter a six-digit hex colour such as #7a3e00.',
  id: 'Use lowercase letters, digits and underscores, starting with a letter.',
};
const TYPE_HINT = { integer: 'Enter a whole number.', number: 'Enter a number.', string: 'Enter text.', boolean: 'Turn this on or off.', array: 'Enter a list.', object: 'Enter a JSON object.' };

/**
 * Plain-language message for a validation problem. Schema messages ('must match ^[A-Z]{2,5}$') are rewritten;
 * semantic messages from the server are kept, sentence-cased.
 * @param {{path:string, code?:string, message:string}} e
 */
export function friendlyMessage(e, cfg) {
  const segs = parsePointer(e.path);
  const last = segs[segs.length - 1] ?? '';
  const msg = String(e.message ?? '');
  const code = e.code ?? (/^must match /.test(msg) ? 'pattern' : /^must be one of /.test(msg) ? 'enum' : /^is required$/.test(msg) ? 'required'
    : /^must be (>=|<=|>|<) /.test(msg) ? 'range' : /^must be [a-z]+( or [a-z]+)*$/.test(msg) ? 'type' : null);
  const field = FIELD_LABEL[last] ?? humanizeKey(last);
  switch (code) {
    case 'pattern': {
      if (PATTERN_HINT[last]) return PATTERN_HINT[last];
      if (segs[0] === 'rules' && last === 'id') return 'Use capital letters, digits and dashes, for example RT-INJURY-01.';
      return 'This value is not in the expected format.';
    }
    case 'enum': return last === 'type' && segs.includes('questions') ? 'Choose a question type.' : 'Choose one of the listed options.';
    case 'required': return `${field || 'This value'} is required.`;
    case 'type': { const t = /must be ([a-z]+)/.exec(msg)?.[1]; return TYPE_HINT[t] ?? 'This value has the wrong type.'; }
    case 'minimum': case 'maximum': case 'exclusiveMinimum': case 'exclusiveMaximum': case 'range': {
      const m = /must be (>=|<=|>|<) (\S+)/.exec(msg);
      if (!m) return sentence(msg);
      return { '>=': `Enter ${m[2]} or more.`, '<=': `Enter ${m[2]} or less.`, '>': `Enter more than ${m[2]}.`, '<': `Enter less than ${m[2]}.` }[m[1]];
    }
    case 'minLength': return `Enter at least ${/\d+/.exec(msg)?.[0] ?? 1} characters.`;
    case 'maxLength': return `Enter at most ${/\d+/.exec(msg)?.[0] ?? ''} characters.`;
    case 'minItems': return `Add at least ${/\d+/.exec(msg)?.[0] ?? 1} item(s).`;
    case 'maxItems': return `Use at most ${/\d+/.exec(msg)?.[0] ?? ''} items.`;
    case 'format': return /email/.test(msg) ? 'Enter a valid email address.' : /date/.test(msg) ? 'Enter a date as YYYY-MM-DD.' : 'This value is not in the expected format.';
    case 'additionalProperties': return 'This setting is not supported here. Remove it.';
    case 'oneOf': case 'anyOf': return ['text', 'label', 'help', 'legalFooter'].includes(last) ? 'Enter text, or one text per language.' : 'This value does not match any allowed shape.';
    case 'const': return last === 'includePii' ? 'Webhooks cannot include personal data.' : 'This value cannot be changed.';
    case 'uniqueItems': return 'Remove the duplicate entries.';
    default: return sentence(msg.replace(/\^[^\s]*\$/g, 'the expected format'));
  }
}

/** Threshold a task uses when its own field is blank (mirrors src/ai/cascade.mjs: local entry, then 0.7). */
export function inheritedThreshold(ai, task) {
  const cascade = Array.isArray(ai?.cascade) ? ai.cascade : [];
  const entries = ai?.provider === 'cascade' ? cascade.filter((e) => !e?.tasks?.length || e.tasks.includes(task)) : [];
  const local = entries.find((e) => e?.provider === 'local');
  if (Number.isFinite(local?.minConfidence)) return { value: local.minConfidence, source: 'the local provider minimum in the cascade' };
  if (Number.isFinite(ai?.minConfidence)) return { value: ai.minConfidence, source: 'the AI minimum confidence' };
  return { value: 0.7, source: 'the platform default' };
}
