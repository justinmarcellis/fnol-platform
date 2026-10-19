// Presentation helpers for the claimant app. Pure logic: no DOM, no kit imports (formatters are injected).
// Turns raw answers into readable review rows, validates scalar values inline and describes vehicle cards.
import { localText } from './strings.js';
import { isStructured } from './structured.js';

/** Overall steps shown in the progress header: details, questions, review, done. */
export const STAGES = ['details', 'questions', 'review', 'done'];

/** 1-based step number for a stage id (0 for the welcome screen or unknown). */
export function stageNumber(stage) {
  const i = STAGES.indexOf(stage);
  return i < 0 ? 0 : i + 1;
}

/**
 * Segment fill (0..100) for each stage while `stage` is active: earlier stages full, later empty,
 * the questions stage follows the server's progress percent.
 * @param {string} stage
 * @param {number} [percent] questions progress 0..100
 */
export function segmentFills(stage, percent = 0) {
  const at = STAGES.indexOf(stage);
  return STAGES.map((id, i) => {
    if (at < 0) return 0;
    if (i < at) return 100;
    if (i > at) return 0;
    return id === 'questions' ? Math.max(8, Math.min(100, Math.round(percent))) : 100;
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Inline validation for a scalar answer. Returns an i18n key for the message, or '' when the value is acceptable.
 * Empty values are not judged here (required-ness is checked separately).
 * @param {string} type Question.type
 * @param {string|number|undefined} raw the entered value
 */
export function validateScalar(type, raw, question = null, { today } = {}) {
  const v = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!v) return '';
  const rules = question?.validation ?? {};
  if (type === 'email' && !EMAIL.test(v)) return 'claimant.guided.invalidEmail';
  if (type === 'phone' && v.replace(/\D/g, '').length < 7) return 'claimant.guided.invalidPhone';
  if (type === 'number' || type === 'currency') {
    const n = Number(v);
    if (!Number.isFinite(n)) return 'claimant.guided.invalidNumber';
    if (rules.min !== undefined && n < rules.min) return 'claimant.guided.tooSmall';
    if (rules.max !== undefined && n > rules.max) return 'claimant.guided.tooLarge';
  }
  if (type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) return 'claimant.guided.invalidDate';
    if (rules.notInFuture && today && v > today) return 'claimant.guided.futureDate';
  }
  return '';
}

// ---- plain-language errors (CLAIMANT-3): the claimant never sees API codes, channel ids or line-of-business codes.
const ERROR_KEYS = {
  unsupported_channel: 'claimant.error.notOnline',
  unsupported_lob: 'claimant.error.notOnline',
  no_question_set: 'claimant.error.notOnline',
  session_expired: 'claimant.error.expired',
  session_not_active: 'claimant.error.expired',
  validation_failed: 'claimant.guided.fixErrors',
  session_incomplete: 'claimant.error.incomplete',
  submit_blocked: 'claimant.error.blocked',
  answer_too_large: 'claimant.error.tooLarge',
  not_found: 'claimant.error.notFound',
  forbidden: 'claimant.error.retry',
  unauthorized: 'claimant.error.expired',
};

/**
 * i18n key of the message to show for an API error ({ code, status }). Unknown codes get a generic retry message.
 * Messages take a {phone} parameter (the tenant support phone).
 * @param {{ code?: string, status?: number } | null | undefined} err
 */
export function friendlyErrorKey(err) {
  return ERROR_KEYS[err?.code] ?? 'claimant.error.retry';
}

/** The line of business accepts claims through this channel (lob.channels absent means every channel). */
export function lobOffersChannel(lob, channel) {
  return !!lob && lob.enabled !== false && (!Array.isArray(lob.channels) || !lob.channels.length || lob.channels.includes(channel));
}

/** Lines of business whose policies carry vehicles (personal and commercial auto). */
export function lobUsesVehicles(lob) {
  return /^AUTO/i.test(lob?.acordLobCd ?? '') || /auto/i.test(lob?.id ?? '');
}

const POLICY_PREFIX = { PA: ['personal_auto', 'AUTOP'], HO: ['homeowners', 'HOME'], CA: ['commercial_auto', 'AUTOB'], DP: ['dwelling_fire', 'DFIRE'] };

/**
 * Line of business id implied by a policy number prefix (PA-, HO-, CA-), among the offered lobs, or null.
 * @param {string} policyNumber
 * @param {{ id: string, acordLobCd?: string }[]} lobs
 */
export function lobForPolicy(policyNumber, lobs = []) {
  const m = /^\s*([A-Za-z]{2})-/.exec(String(policyNumber ?? ''));
  const hit = m ? POLICY_PREFIX[m[1].toUpperCase()] : null;
  if (!hit) return null;
  return (lobs.find((l) => l.id === hit[0]) ?? lobs.find((l) => l.acordLobCd === hit[1]))?.id ?? null;
}

/**
 * Policy numbers carry at least 6 characters and 5 digits (e.g. HO-IL-1030185). An obviously wrong one ('ZZ-999') is
 * caught when typed, before the holder check would fail with a message about the name or ZIP.
 */
export function plausiblePolicyNumber(value) {
  const v = String(value ?? '').trim();
  if (!v) return true;
  return /^[A-Za-z0-9][A-Za-z0-9 -]{4,30}$/.test(v) && (v.match(/\d/g) ?? []).length >= 5;
}

/**
 * Re-localize the fraud notices of a step: the server words them in the session locale, the tenant config holds every locale.
 * A notice that matches a configured warning (in any locale) is shown in `locale`; anything else is shown as sent.
 * @param {string[]} list step.disclosures
 * @param {Record<string, string|Record<string,string>>} [warnings] config.branding.fraudWarning
 * @param {string} locale
 */
export function localizeDisclosures(list, warnings, locale) {
  const entries = Object.values(warnings ?? {});
  return (list ?? []).map((d) => {
    const hit = entries.find((w) => (typeof w === 'string' ? w === d : Object.values(w ?? {}).includes(d)));
    return hit ? localText(hit, locale) : d;
  });
}

/**
 * Split a policy vehicle option into a card title and a secondary line.
 * @param {{ label: string, answer?: { year?: number, make?: string, model?: string }, unitId?: string }} option
 * @returns {{ title: string, last4: string }}
 */
export function vehicleCard(option) {
  const a = option?.answer ?? {};
  const built = [a.year, a.make, a.model].filter(Boolean).join(' ');
  const m = /\(VIN \.\.\.([A-Za-z0-9]+)\)\s*$/.exec(option?.label ?? '');
  const title = built || String(option?.label ?? '').replace(/\s*\(VIN[^)]*\)\s*$/, '') || String(option?.unitId ?? '');
  return { title, last4: m ? m[1] : '' };
}

const joinParts = (parts) => parts.filter((p) => p !== undefined && p !== null && String(p).trim() !== '').join(', ');

/**
 * Human text for an answered question, for the review screen.
 * @param {any} question the Question the server asked
 * @param {any} value what the claimant answered
 * @param {{ t: Function, locale?: string, fmt?: { date?: Function, dateTime?: Function, money?: Function, enumLabel?: Function } }} deps
 * @returns {string} '' when there is nothing to show
 */
export function displayAnswer(question, value, { t, locale = 'en', fmt = {} } = {}) {
  if (value === undefined || value === null || value === '') return '';
  const type = question?.type;
  if (type === 'boolean' || (typeof value === 'boolean' && type !== 'disclosure')) return value === true || value === 'true' ? t('claimant.guided.yes') : t('claimant.guided.no');
  if (type === 'disclosure') return value ? t('claimant.guided.acknowledge') : '';
  if (type === 'select' || type === 'multiselect') {
    const opts = question.options ?? [];
    const one = (v) => {
      const o = opts.find((x) => x.value === v);
      return o ? localText(o.label, locale) : (fmt.enumLabel ? fmt.enumLabel(v) : String(v));
    };
    return Array.isArray(value) ? value.map(one).join(', ') : one(value);
  }
  if (type === 'media') {
    const n = Array.isArray(value) ? value.length : 1;
    return t(`claimant.media.count.${n === 1 ? 'one' : 'other'}`, { n });
  }
  if (type === 'date') return fmt.date ? fmt.date(value) : String(value);
  if (type === 'datetime') return fmt.dateTime ? fmt.dateTime(value) : String(value);
  if (type === 'currency') return fmt.money ? fmt.money(Number(value)) : String(value);
  if (isStructured(question) && typeof value === 'object') {
    if (type === 'party') return joinParts([[value.firstName, value.lastName].filter(Boolean).join(' '), (value.roles ?? []).map((r) => (fmt.enumLabel ? fmt.enumLabel(r) : r)).join(' / '), value.phone, value.insurerName]);
    if (type === 'vehicle') return joinParts([[value.year, value.make, value.model].filter(Boolean).join(' '), value.licensePlate]);
    if (type === 'address') return joinParts([value.line1, value.city, [value.state, value.postalCode].filter(Boolean).join(' ')]);
  }
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return '';
  return String(value);
}

/**
 * Review rows from the answers the claimant gave, in the order they were answered.
 * @param {Map<string, { label: string, text: string }>|Array<{label:string,text:string}>} answers
 * @returns {{ label: string, text: string, skipped: boolean }[]}
 */
export function reviewRows(answers) {
  const list = answers instanceof Map ? [...answers.values()] : Array.isArray(answers) ? answers : [];
  return list.map((a) => ({ ...(a.id ? { id: a.id } : {}), label: a.label, text: a.text ?? '', skipped: !a.text }));
}

/** i18n key for the "what happens next" sentence of a claim status. */
export function nextStepKey(status) {
  return `claimant.next.${status ?? 'reported'}`;
}

/**
 * Number of the question on screen (S6-RA-09): its position among the questions shown, in order, leaving out the one the
 * policy-vehicle picker answered. Skipped optional questions keep their number, so no two questions share one.
 * @param {{ question?: any, history?: string[], pickedQuestionId?: string|null, progress?: { answered?: number } }} s flow snapshot
 * @returns {number}
 */
export function questionNumber(s) {
  const id = s?.question?.id;
  const shown = (s?.history ?? []).filter((x) => x !== s?.pickedQuestionId);
  const i = id ? shown.indexOf(id) : -1;
  return i >= 0 ? i + 1 : answeredCount(s) + 1;
}

/**
 * Answers the claimant gave to questions (S6-RA-09): the server's count without the vehicle the picker filled in.
 * @param {{ progress?: { answered?: number }, pickedQuestionId?: string|null, answers?: Record<string, any> }} s flow snapshot
 * @returns {number}
 */
export function answeredCount(s) {
  const n = s?.progress?.answered ?? 0;
  const picked = s?.pickedQuestionId && s?.answers && Object.prototype.hasOwnProperty.call(s.answers, s.pickedQuestionId) ? 1 : 0;
  return Math.max(0, n - picked);
}
