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
export function validateScalar(type, raw) {
  const v = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!v) return '';
  if (type === 'email' && !EMAIL.test(v)) return 'claimant.guided.invalidEmail';
  if (type === 'phone' && v.replace(/\D/g, '').length < 7) return 'claimant.guided.invalidPhone';
  if ((type === 'number' || type === 'currency') && !Number.isFinite(Number(v))) return 'claimant.guided.invalidNumber';
  return '';
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
  if (type === 'boolean') return value === true || value === 'true' ? t('claimant.guided.yes') : t('claimant.guided.no');
  if (type === 'disclosure') return value ? t('claimant.guided.acknowledge') : '';
  if (type === 'select' || type === 'multiselect') {
    const opts = question.options ?? [];
    const one = (v) => {
      const o = opts.find((x) => x.value === v);
      return o ? localText(o.label, locale) : (fmt.enumLabel ? fmt.enumLabel(v) : String(v));
    };
    return Array.isArray(value) ? value.map(one).join(', ') : one(value);
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
  return list.map((a) => ({ label: a.label, text: a.text ?? '', skipped: !a.text }));
}

/** i18n key for the "what happens next" sentence of a claim status. */
export function nextStepKey(status) {
  return `claimant.next.${status ?? 'reported'}`;
}
