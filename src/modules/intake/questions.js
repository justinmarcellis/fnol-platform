// Question engine: pure functions over a tenant question set (TenantConfig.questionSets[]).
// Visibility and requiredness come from conditions evaluated by rules.evaluateCondition (injected),
// so a question added in tenant config appears with no code change.
import { isSafePattern, compileSafePattern, matchWithBudget } from '../../core/safe-pattern.mjs';
export { isSafePattern };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ().-]{7,20}$/;
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

/** Pick a localized string from an I18nText ({ en, es }), falling back to en then any value. */
export function localize(text, locale = 'en') {
  if (text == null) return '';
  if (typeof text === 'string') return text;
  return text[locale] ?? text[String(locale).split('-')[0]] ?? text.en ?? Object.values(text)[0] ?? '';
}

/** Facts for showIf / requiredIf: answers.<id>, session.*, policy.*. */
export function buildFacts(session, answers) {
  return {
    answers: Object.fromEntries(Object.entries(answers ?? {}).map(([k, v]) => [k, v?.value])),
    session: { lob: session.lob, lossType: session.lossType, channel: session.channel, locale: session.locale, policyNumber: session.policyNumber },
    policy: { number: session.policyNumber },
  };
}

const bySequence = (set) => [...set.questions]
  .map((q, i) => ({ q, i }))
  .sort((a, b) => (a.q.order ?? 1e6) - (b.q.order ?? 1e6) || a.i - b.i)
  .map((x) => x.q);

/**
 * Evaluate which questions apply now.
 * @param {object} set question set
 * @param {object} facts from buildFacts
 * @param {(cond: object, facts: object) => { result: boolean }} evalCond rules.evaluateCondition
 * @param {Set<string>} [forcedRequired] question ids made required by intake rules (require_question)
 * @returns {{ visible: object[], required: Set<string> }}
 */
export function applicable(set, facts, evalCond, forcedRequired = new Set()) {
  const visible = [];
  const required = new Set();
  for (const q of bySequence(set)) {
    if (q.showIf && !evalCond(q.showIf, facts).result) continue;
    visible.push(q);
    if (q.required || forcedRequired.has(q.id) || (q.requiredIf && evalCond(q.requiredIf, facts).result)) required.add(q.id);
  }
  return { visible, required };
}

const isBlank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Validate one answer value against its question. Returns an error message (in locale) or null.
 * @param {object} q question
 * @param {*} value
 * @param {{ locale?: string, today?: string }} [o] today is an ISO date for notInFuture
 */
export function validateAnswer(q, value, { locale = 'en', today } = {}) {
  const es = String(locale).startsWith('es');
  const m = (en, sp) => (es ? sp : en);
  if (isBlank(value)) return q.type === 'disclosure' ? m('Acknowledgement is required.', 'Se requiere confirmación.') : m('A value is required.', 'Se requiere un valor.');
  const v = q.validation ?? {};
  const num = () => (typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN));
  switch (q.type) {
    case 'number':
    case 'currency': {
      const n = num();
      if (!Number.isFinite(n)) return m('Enter a number.', 'Ingrese un número.');
      if (v.min !== undefined && n < v.min) return m(`Must be at least ${v.min}.`, `Debe ser al menos ${v.min}.`);
      if (v.max !== undefined && n > v.max) return m(`Must be at most ${v.max}.`, `Debe ser como máximo ${v.max}.`);
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : m('Answer yes or no.', 'Responda sí o no.');
    case 'disclosure':
      return value === true ? null : m('You must acknowledge this statement.', 'Debe confirmar esta declaración.');
    case 'date':
    case 'datetime': {
      const s = String(value);
      const day = s.slice(0, 10);
      if (!DATE_RE.test(day) || Number.isNaN(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) return m('Enter a valid date (YYYY-MM-DD).', 'Ingrese una fecha válida (AAAA-MM-DD).');
      if (q.type === 'date' && s.length !== 10) return m('Enter a valid date (YYYY-MM-DD).', 'Ingrese una fecha válida (AAAA-MM-DD).');
      if (v.notInFuture && today && day > today) return m('The date cannot be in the future.', 'La fecha no puede ser futura.');
      return null;
    }
    case 'time':
      return TIME_RE.test(String(value)) ? null : m('Enter a time as HH:MM.', 'Ingrese la hora como HH:MM.');
    case 'select':
      if (typeof value !== 'string') return m('Choose one option.', 'Elija una opción.');
      return (q.options ?? []).some((o) => o.value === value) ? null : m('Choose one of the listed options.', 'Elija una de las opciones.');
    case 'multiselect': {
      if (!Array.isArray(value)) return m('Choose one or more options.', 'Elija una o más opciones.');
      const allowed = new Set((q.options ?? []).map((o) => o.value));
      return value.every((x) => allowed.has(x)) ? null : m('Choose from the listed options.', 'Elija entre las opciones.');
    }
    case 'phone':
      return PHONE_RE.test(String(value)) ? null : m('Enter a valid phone number.', 'Ingrese un teléfono válido.');
    case 'email':
      return EMAIL_RE.test(String(value)) ? null : m('Enter a valid email address.', 'Ingrese un correo válido.');
    case 'vin':
      return VIN_RE.test(String(value)) ? null : m('A VIN has 17 characters (no I, O or Q).', 'El VIN tiene 17 caracteres (sin I, O ni Q).');
    case 'party':
    case 'vehicle':
    case 'address':
    case 'location':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return m('Provide the requested details.', 'Proporcione los datos solicitados.');
      return null;
    case 'media':
      return Array.isArray(value) || typeof value === 'string' || (typeof value === 'object' && value !== null)
        ? null : m('Attach a file or reference.', 'Adjunte un archivo o referencia.');
    case 'text':
    case 'longtext':
    default: {
      if (typeof value !== 'string') return m('Enter text.', 'Ingrese texto.');
      const max = v.maxLength ?? (q.type === 'longtext' ? 8000 : 500);
      if (value.length > max) return m(`Must be ${max} characters or fewer.`, `Debe tener ${max} caracteres o menos.`);
      if (v.pattern) {
        // Unsafe or invalid tenant patterns are skipped (never executed): they can neither hang nor block the claimant.
        const re = compileSafePattern(v.pattern);
        // Input is capped (SEC3-003) and evaluation is time-boxed; a timeout counts as invalid.
        if (re && matchWithBudget(re, value) !== true) return m('The format is not valid.', 'El formato no es válido.');
      }
      return null;
    }
  }
}

/**
 * Compute the next step state from visible questions and answers.
 * `next` is the first unanswered visible required question (null when none, per the IntakeStep contract).
 * `optional` lists unanswered visible optional questions.
 */
export function plan(visible, required, answers) {
  const answered = (q) => !isBlank(answers?.[q.id]?.value);
  const requiredQs = visible.filter((q) => required.has(q.id));
  const remaining = requiredQs.filter((q) => !answered(q));
  const answeredVisible = visible.filter(answered).length;
  const total = visible.length;
  return {
    next: remaining[0] ?? null,
    remaining,
    optional: visible.filter((q) => !required.has(q.id) && !answered(q)),
    progress: {
      answered: answeredVisible,
      requiredRemaining: remaining.length,
      percent: total ? Math.min(100, Math.round((answeredVisible / total) * 100)) : 100,
    },
  };
}

/**
 * Question as sent to clients: contract fields only (text/help/options keep every locale).
 * `required` is the requiredness right now: pass opts.required from applicable() so a question made required by
 * requiredIf (or an intake rule) is not labelled optional (CSR-14). Without it, the static q.required applies.
 * @param {object} q
 * @param {{ required?: boolean }} [opts]
 */
export function publicQuestion(q, opts = {}) {
  if (!q) return null;
  const { mapsTo, ...rest } = q; // eslint-disable-line no-unused-vars
  return { ...rest, required: typeof opts.required === 'boolean' ? opts.required : !!q.required };
}
