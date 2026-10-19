// Display formatting for every app: dates, relative time, enum labels, money, policy and claim numbers.
// Pure functions, locale-aware for en and es. Falls back to the active i18n locale when none is passed.
import { getLocale } from './i18n.js';

const INTL = { en: 'en-US', es: 'es-ES' };
const EMPTY = '—';

/** Normalise a locale ('es-MX' -> 'es', unknown -> 'en'). */
export function baseLocale(locale) {
  const b = String(locale ?? safeLocale()).toLowerCase().split('-')[0];
  return b === 'es' ? 'es' : 'en';
}
function safeLocale() { try { return getLocale(); } catch { return 'en'; } }
const intlTag = (locale) => INTL[baseLocale(locale)];
// ICU may emit narrow no-break spaces (U+202F) or no-break spaces; normalise for stable output and tests.
const clean = (s) => s.replace(/[  ]/g, ' ');

function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Humanized date and time, e.g. 'Oct 19, 2026, 12:24 PM' (en) or '19 oct 2026, 12:24' (es).
 * @param {string|number|Date} value ISO timestamp, epoch ms or Date
 * @param {{locale?:string, timeZone?:string}} [opts] timeZone defaults to the viewer's zone
 * @returns {string} the formatted value, the raw input when unparseable, or an em dash when empty
 */
export function formatDateTime(value, { locale, timeZone } = {}) {
  const d = toDate(value);
  if (!d) return value ? String(value) : EMPTY;
  return clean(new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(d));
}

/** Date only, e.g. 'Oct 19, 2026'. */
export function formatDate(value, { locale, timeZone } = {}) {
  const d = toDate(value);
  if (!d) return value ? String(value) : EMPTY;
  return clean(new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium', ...(timeZone ? { timeZone } : {}) }).format(d));
}

/** Time only, e.g. '12:24 PM'. */
export function formatTime(value, { locale, timeZone } = {}) {
  const d = toDate(value);
  if (!d) return value ? String(value) : EMPTY;
  return clean(new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(d));
}

const REL = {
  en: { now: 'just now', past: '{n} {u} ago', future: 'in {n} {u}', u: { s: 's', min: 'min', h: 'h', d: 'd' } },
  es: { now: 'ahora mismo', past: 'hace {n} {u}', future: 'en {n} {u}', u: { s: 's', min: 'min', h: 'h', d: 'd' } },
};

/**
 * Short relative time: '3 min ago', 'in 2 h', '5 d ago', 'just now' (es: 'hace 3 min', 'en 2 h').
 * Beyond `maxDays` (default 7) it falls back to formatDate.
 * @param {string|number|Date} value
 * @param {{now?:string|number|Date, locale?:string, maxDays?:number, timeZone?:string}} [opts]
 */
export function formatRelative(value, { now = Date.now(), locale, maxDays = 7, timeZone } = {}) {
  const d = toDate(value);
  if (!d) return value ? String(value) : EMPTY;
  const ref = toDate(now) ?? new Date();
  const diff = d.getTime() - ref.getTime();
  const abs = Math.abs(diff);
  const L = REL[baseLocale(locale)];
  if (abs < 45 * 1000) return L.now;
  let n; let u;
  if (abs < 60 * 60 * 1000) { n = Math.max(1, Math.round(abs / 60000)); u = 'min'; }
  else if (abs < 24 * 60 * 60 * 1000) { n = Math.round(abs / 3600000); u = 'h'; }
  else if (abs < maxDays * 24 * 60 * 60 * 1000) { n = Math.round(abs / 86400000); u = 'd'; }
  else return formatDate(d, { locale, timeZone });
  if (u === 'min' && n === 60) { n = 1; u = 'h'; }
  if (u === 'h' && n === 24) { n = 1; u = 'd'; }
  return (diff < 0 ? L.past : L.future).replace('{n}', String(n)).replace('{u}', L.u[u]);
}

/** Known enum values with hand-written labels. Anything else is humanized from its token. */
const LABELS = {
  en: {
    reported: 'Reported', validating: 'Validating', triaged: 'Triaged', assigned: 'Assigned', fast_tracked: 'Fast-tracked',
    in_review: 'In review', pending_info: 'Pending info', closed: 'Closed', withdrawn: 'Withdrawn',
    minor: 'Minor', moderate: 'Moderate', major: 'Major', severe: 'Severe',
    open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled',
    pending: 'Pending', synced: 'Synced', failed: 'Failed', covered: 'Covered', partial: 'Partially covered', not_covered: 'Not covered', needs_review: 'Needs review',
    low: 'Low', medium: 'Medium', high: 'High',
    personal_auto: 'Personal auto', commercial_auto: 'Commercial auto', homeowners: 'Homeowners',
    claimant_web: 'Web', claimant_mobile: 'Mobile', csr_phone: 'Phone (CSR)', agent_portal: 'Agent portal', api: 'API', email: 'Email', partner: 'Partner',
  },
  es: {
    reported: 'Reportado', validating: 'Validando', triaged: 'Clasificado', assigned: 'Asignado', fast_tracked: 'Vía rápida',
    in_review: 'En revisión', pending_info: 'Información pendiente', closed: 'Cerrado', withdrawn: 'Retirado',
    minor: 'Leve', moderate: 'Moderado', major: 'Grave', severe: 'Muy grave',
    open: 'Abierta', in_progress: 'En curso', done: 'Hecha', cancelled: 'Cancelada',
    pending: 'Pendiente', synced: 'Sincronizado', failed: 'Fallido', covered: 'Cubierto', partial: 'Cobertura parcial', not_covered: 'Sin cobertura', needs_review: 'Requiere revisión',
    low: 'Baja', medium: 'Media', high: 'Alta',
    personal_auto: 'Auto personal', commercial_auto: 'Auto comercial', homeowners: 'Hogar',
    claimant_web: 'Web', claimant_mobile: 'Móvil', csr_phone: 'Teléfono (agente)', agent_portal: 'Portal de agentes', api: 'API', email: 'Correo', partner: 'Socio',
  },
};

/**
 * Human label for an enum token: 'pending_info' -> 'Pending info', 'commercial_auto' -> 'Commercial auto'.
 * Known platform enums have curated en/es labels; unknown tokens are humanized (snake/kebab/camel -> sentence case).
 * @param {string} value
 * @param {{locale?:string}} [opts]
 */
export function formatEnum(value, { locale } = {}) {
  if (value === null || value === undefined || value === '') return EMPTY;
  const key = String(value);
  const known = LABELS[baseLocale(locale)][key] ?? LABELS[baseLocale(locale)][key.toLowerCase()];
  if (known) return known;
  return humanize(key);
}

/** Sentence-case a token without dictionary lookup. */
export function humanize(token) {
  const words = String(token ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return EMPTY;
  return words.map((w, i) => {
    if (/^[A-Z0-9]{2,}$/.test(w)) return w; // keep acronyms (VIN, ACORD, WI)
    const lw = w.toLowerCase();
    return i === 0 ? lw.charAt(0).toUpperCase() + lw.slice(1) : lw;
  }).join(' ');
}

/**
 * Money. Accepts a number (major units) or a contract Money object {amount, currency}.
 * @param {number|{amount:number,currency?:string}} value
 * @param {{currency?:string, locale?:string, compact?:boolean, cents?:boolean}} [opts] cents=false drops minor units
 */
export function formatMoney(value, { currency, locale, compact = false, cents } = {}) {
  const amount = typeof value === 'object' && value !== null ? value.amount : value;
  const cur = (typeof value === 'object' && value?.currency) || currency || 'USD';
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (typeof n !== 'number' || !Number.isFinite(n)) return EMPTY;
  const opts = { style: 'currency', currency: cur };
  if (compact) Object.assign(opts, { notation: 'compact', maximumFractionDigits: 1 });
  else if (cents === false || (cents === undefined && Number.isInteger(n) && Math.abs(n) >= 1000)) Object.assign(opts, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return clean(new Intl.NumberFormat(intlTag(locale), opts).format(n));
}

/** Plain number with grouping, e.g. 12,480 (en) / 12.480 (es). */
export function formatNumber(value, { locale, maximumFractionDigits = 1 } = {}) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return EMPTY;
  return clean(new Intl.NumberFormat(intlTag(locale), { maximumFractionDigits, useGrouping: true }).format(n));
}

/** Percent from a ratio (0.42 -> '42%'). */
export function formatPercent(ratio, { locale, maximumFractionDigits = 0 } = {}) {
  const n = typeof ratio === 'string' ? Number(ratio) : ratio;
  if (typeof n !== 'number' || !Number.isFinite(n)) return EMPTY;
  return clean(new Intl.NumberFormat(intlTag(locale), { style: 'percent', maximumFractionDigits }).format(n));
}

/** Duration in minutes -> '45 min', '2 h 5 min', '3 d 4 h'. */
export function formatDuration(minutes, { locale } = {}) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 0) return EMPTY;
  const d = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60); const mm = Math.round(m % 60);
  const u = REL[baseLocale(locale)].u;
  if (d) return h ? `${d} ${u.d} ${h} ${u.h}` : `${d} ${u.d}`;
  if (h) return mm ? `${h} ${u.h} ${mm} ${u.min}` : `${h} ${u.h}`;
  return `${mm} ${u.min}`;
}

function normalizeRef(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[\s_/.]+/g, '-').replace(/[^A-Z0-9-]/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}

/**
 * Policy number for display: trimmed, upper case, dash separated ('pa mi 2241587' -> 'PA-MI-2241587').
 * A compact form like 'PAMI2241587' becomes 'PA-MI-2241587' (two letters, two letters, digits).
 * `mask: true` keeps the last 4 digits only ('PA-MI-•••1587').
 */
export function formatPolicyNumber(value, { mask = false } = {}) {
  let s = normalizeRef(value);
  if (!s) return EMPTY;
  const compact = /^([A-Z]{2})([A-Z]{2})(\d{4,})$/.exec(s);
  if (compact) s = `${compact[1]}-${compact[2]}-${compact[3]}`;
  if (mask) s = s.replace(/(\d+)(\d{4})$/, (_, a, b) => '•'.repeat(Math.min(a.length, 3)) + b);
  return s;
}

/**
 * Claim number for display: 'kpt-2026-15' -> 'KPT-2026-000015' (prefix, year, sequence padded to 6).
 * Values that do not look like platform claim numbers are only normalised.
 */
export function formatClaimNumber(value) {
  const s = normalizeRef(value);
  if (!s) return EMPTY;
  const m = /^([A-Z]{2,6})-?(\d{4})-?(\d{1,9})$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3].padStart(6, '0')}` : s;
}

/** Initials for an avatar ('Dana Whitfield' -> 'DW'; one word -> first two letters). */
export function initials(name) {
  // Ignore parentheticals and words without letters ('Northwind Mutual (fictional)' -> 'NM').
  const parts = String(name ?? '').replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).filter((w) => /\p{L}/u.test(w)).map((w) => w.replace(/^[^\p{L}\d]+/u, ''));
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
