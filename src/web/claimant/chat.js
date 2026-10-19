// Conversational mode: a transcript built on top of the intake flow.
// Free-text answers are coerced to the question type, AI prefills need confirm/edit.
// A free-text story goes to POST /intake/sessions/{id}/narrative; structured answers (party, vehicle, media) come from a sub-form.
import { localText } from './strings.js';
import { friendlyErrorKey } from './present.js';

const MONTHS = {
  january: 1, jan: 1, enero: 1, ene: 1, february: 2, feb: 2, febrero: 2, march: 3, mar: 3, marzo: 3, april: 4, apr: 4, abril: 4, abr: 4,
  may: 5, mayo: 5, june: 6, jun: 6, junio: 6, july: 7, jul: 7, julio: 7, august: 8, aug: 8, agosto: 8, ago: 8,
  september: 9, sep: 9, sept: 9, septiembre: 9, setiembre: 9, october: 10, oct: 10, octubre: 10, november: 11, nov: 11, noviembre: 11,
  december: 12, dec: 12, diciembre: 12, dic: 12,
};
const WEEKDAYS = { sunday: 0, domingo: 0, monday: 1, lunes: 1, tuesday: 2, martes: 2, wednesday: 3, miercoles: 3, thursday: 4, jueves: 4, friday: 5, viernes: 5, saturday: 6, sabado: 6 };
const pad2 = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => {
  const iso = `${y}-${pad2(m)}-${pad2(d)}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === iso ? iso : null;
};
const shift = (today, days) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/**
 * Read a date the way people type it: 2026-10-18, 10/18/2026, 10/18, today, yesterday, 3 days ago, last Friday,
 * October 18, 18 de octubre (2026). A date without a year that would be in the future means last year.
 * @param {string} text
 * @param {string} today ISO date (YYYY-MM-DD)
 * @returns {string|null} ISO date or null
 */
export function parseNaturalDate(text, today) {
  const raw = String(text ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(today ?? '')) return null;
  const [ty] = today.split('-').map(Number);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (m) return isoOf(+m[1], +m[2], +m[3]);
  if (/^(today|hoy)$/.test(raw)) return today;
  if (/^(yesterday|ayer)$/.test(raw)) return shift(today, -1);
  if (/^(anteayer|antier|the day before yesterday)$/.test(raw)) return shift(today, -2);
  m = /^(\d{1,3}) days? ago$/.exec(raw) ?? /^hace (\d{1,3}) dias?$/.exec(raw);
  if (m) return shift(today, -Number(m[1]));
  m = /^(?:last |el |el pasado |pasado )?([a-z]+)(?: pasado)?$/.exec(raw);
  if (m && WEEKDAYS[m[1]] !== undefined) {
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    const back = ((dow - WEEKDAYS[m[1]] + 7) % 7) || 7;
    return shift(today, -back);
  }
  const withYear = (y, mo, d) => {
    if (y !== undefined) return isoOf(y < 100 ? 2000 + y : y, mo, d);
    const iso = isoOf(ty, mo, d);
    return iso && iso > today ? isoOf(ty - 1, mo, d) : iso;
  };
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(raw);
  if (m) return withYear(m[3] === undefined ? undefined : +m[3], +m[1], +m[2]);
  m = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(raw);
  if (m && MONTHS[m[1]]) return withYear(m[3] === undefined ? undefined : +m[3], MONTHS[m[1]], +m[2]);
  m = /^(\d{1,2})(?: de)? ([a-z]+)(?:(?: de)? (\d{4}))?$/.exec(raw);
  if (m && MONTHS[m[2]]) return withYear(m[3] === undefined ? undefined : +m[3], MONTHS[m[2]], +m[1]);
  return null;
}

/** Words that skip an optional question in chat. */
const SKIP_WORDS = ['skip', 'omitir', 'saltar', 'pass', 'n/a'];

/**
 * True when free text looks like a story rather than an answer to the current (non-text) question,
 * so it should go to the narrative endpoint instead of being forced into the question type.
 */
export function looksLikeNarrative(question, text) {
  if (!question || ['text', 'longtext'].includes(question.type)) return false;
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  return words.length >= 6;
}

/**
 * Coerce free text into an answer value for a question.
 * @param {any} question
 * @param {string} text
 * @param {{ locale?: string, yes?: string[], no?: string[] }} [opts]
 * @returns {{ ok: true, value: any } | { ok: false, code: string, options?: string[] }}
 */
export function coerceAnswer(question, text, opts = {}) {
  const locale = opts.locale ?? 'en';
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, code: 'empty' };
  if (question && !question.required && SKIP_WORDS.includes(raw.toLowerCase())) return { ok: true, skip: true };
  switch (question?.type) {
    case 'date': {
      const iso = parseNaturalDate(raw, opts.today ?? new Date().toISOString().slice(0, 10));
      return iso ? { ok: true, value: iso } : { ok: false, code: 'badDate' };
    }
    case 'party':
    case 'vehicle':
    case 'address':
    case 'media':
      return { ok: false, code: 'useForm' };
    case 'number':
    case 'currency': {
      const n = Number(raw.replace(/[$,\s]/g, ''));
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, code: 'badNumber' };
    }
    case 'boolean': {
      const l = raw.toLowerCase();
      if (['yes', 'y', 'true', 'si', 'sí', 's'].includes(l)) return { ok: true, value: true };
      if (['no', 'n', 'false'].includes(l)) return { ok: true, value: false };
      return { ok: false, code: 'badBoolean' };
    }
    case 'select':
    case 'multiselect': {
      const options = question.options ?? [];
      const match = (piece) => {
        const p = piece.trim().toLowerCase();
        return options.find((o) => o.value.toLowerCase() === p || localText(o.label, locale).toLowerCase() === p);
      };
      const pieces = question.type === 'multiselect' ? raw.split(',') : [raw];
      const found = pieces.map(match);
      if (!options.length) return { ok: true, value: question.type === 'multiselect' ? pieces.map((x) => x.trim()) : raw };
      if (found.some((f) => !f)) return { ok: false, code: 'pickOne', options: options.map((o) => localText(o.label, locale)) };
      const values = found.map((f) => f.value);
      return { ok: true, value: question.type === 'multiselect' ? values : values[0] };
    }
    case 'disclosure':
      return { ok: true, value: true };
    default:
      return { ok: true, value: raw };
  }
}

/** Human-readable text for an answer value. */
export function displayValue(question, value, locale = 'en', t = null) {
  if (Array.isArray(value)) return value.map((v) => displayValue(question, v, locale, t)).join(', ');
  const opt = question?.options?.find((o) => o.value === value);
  if (opt) return localText(opt.label, locale);
  if (value === true) return t ? t('claimant.guided.yes') : 'yes';
  if (value === false) return t ? t('claimant.guided.no') : 'no';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

/**
 * Create the chat controller.
 * @param {{ flow: any, t: Function, locale?: () => string }} deps
 */
export function createChat({ flow, t, locale = () => 'en', today = () => new Date().toISOString().slice(0, 10) }) {
  const listeners = new Set();
  /** @type {any[]} */
  const messages = [];
  let seq = 0;
  let lastAsked = null;
  const suggested = new Map(); // questionId -> message
  let doneAnnounced = false;
  let lastQuestion = null;
  let errorsSeenAt = 0; // flow.stepSeq whose errors are already in the transcript

  const emit = () => { const m = messages.map((x) => ({ ...x })); for (const l of listeners) l(m); };
  const add = (msg) => { const m = { id: `m${++seq}`, ...msg }; messages.push(m); return m; };

  function onState(s) {
    const loc = locale();
    if (s.question) lastQuestion = s.question;
    if (s.question && s.question.id !== lastAsked && s.phase !== 'starting') {
      lastAsked = s.question.id;
      add({ role: 'assistant', kind: 'question', questionId: s.question.id, optional: !s.question.required, text: localText(s.question.text, loc), help: localText(s.question.help, loc) });
    }
    for (const sg of s.suggestions) {
      const prior = suggested.get(sg.questionId);
      if (prior && prior.status === 'pending') continue;
      if (prior && prior.status !== 'pending' && JSON.stringify(prior.value) === JSON.stringify(sg.value)) continue;
      const q = flow.questionFor?.(sg.questionId) ?? (lastQuestion?.id === sg.questionId ? lastQuestion : null);
      const shown = displayValue(q, sg.value, loc, t);
      const msg = add({ role: 'assistant', kind: 'suggestion', questionId: sg.questionId, questionText: localText(q?.text, loc), value: sg.value, shown, ai: sg.ai ?? null, status: 'pending', text: t('claimant.chat.suggested', { value: shown }) });
      suggested.set(sg.questionId, msg);
    }
    // drop suggestions the server no longer lists
    for (const [qid, msg] of suggested) if (msg.status === 'pending' && !s.suggestions.some((x) => x.questionId === qid)) msg.status = 'dismissed';
    // Each server step's errors are shown once, not again on every later re-render.
    if (s.errors.length && (s.stepSeq ?? 0) !== errorsSeenAt) for (const e of s.errors) add({ role: 'assistant', kind: 'error', questionId: e.questionId, text: e.message });
    if (s.errors.length) errorsSeenAt = s.stepSeq ?? 0;
    if (s.phase === 'ready' && !doneAnnounced) { doneAnnounced = true; add({ role: 'assistant', kind: 'done', text: t('claimant.chat.done') }); }
    emit();
  }
  flow.subscribe(onState);

  /** A failure the server did not explain per question gets a plain-language message (never the raw API text). */
  const failed = () => {
    const st = flow.state;
    if (st.phase === 'unavailable' || st.errors.length) return;
    add({ role: 'assistant', kind: 'error', text: t(friendlyErrorKey(st.error), {}) });
    emit();
  };

  const answerFor = async (questionId, value, shown, kind = 'answer') => {
    add({ role: 'user', kind, questionId, text: shown });
    emit();
    const step = await flow.answer(questionId, value);
    if (!step) failed();
    return step;
  };

  return {
    get messages() { return messages.map((x) => ({ ...x })); },
    subscribe(fn) { listeners.add(fn); fn(messages.map((x) => ({ ...x }))); return () => listeners.delete(fn); },

    /** Send a free-text answer for the current question. */
    async sendText(text) {
      const q = flow.state.question;
      if (!q) return { ok: false, code: 'noQuestion' };
      const typed = String(text ?? '').trim();
      // A story ("Yesterday around 5pm another car rear-ended me...") is extracted by the server, not forced into the question type.
      if (typed && looksLikeNarrative(q, typed) && !(q.type === 'date' && parseNaturalDate(typed, today()))) {
        add({ role: 'user', kind: 'narrative', text: typed });
        emit();
        const before = new Set([...suggested.values()].filter((m) => m.status === 'pending').map((m) => m.questionId));
        const step = await flow.narrative(typed);
        if (!step) { failed(); return { ok: false, code: 'narrativeFailed' }; }
        const fresh = (step.suggestions ?? []).filter((sg) => !before.has(sg.questionId));
        const cur = flow.state.question;
        if (fresh.length) add({ role: 'assistant', kind: 'note', text: t('claimant.chat.extracted') });
        // The question still open is asked again after the note, so the claimant knows what to answer next.
        if (cur && !fresh.some((sg) => sg.questionId === cur.id)) {
          lastAsked = cur.id;
          add({ role: 'assistant', kind: 'question', questionId: cur.id, optional: !cur.required, text: fresh.length ? localText(cur.text, locale()) : t('claimant.chat.notExtracted', { question: localText(cur.text, locale()) }), help: localText(cur.help, locale()) });
        }
        emit();
        return { ok: true, narrative: true, suggestions: fresh.length };
      }
      const res = coerceAnswer(q, text, { locale: locale(), today: today() });
      if (res.ok && res.skip) return this.skip();
      if (!res.ok) {
        if (res.code !== 'empty') add({ role: 'user', kind: 'answer', text: String(text).trim() });
        add({ role: 'assistant', kind: 'error', text: t(`claimant.chat.${res.code}`, { options: (res.options ?? []).join(', ') }) });
        emit();
        return res;
      }
      await answerFor(q.id, res.value, String(text).trim());
      return { ok: true, value: res.value };
    },

    /** Send a structured answer (party, vehicle, address, media) from the chat sub-form. */
    async sendValue(value, shown) {
      const q = flow.state.question;
      if (!q) return { ok: false, code: 'noQuestion' };
      const step = await answerFor(q.id, value, shown);
      return { ok: !!step };
    },

    /** Skip the current optional question. */
    skip() {
      const q = flow.state.question;
      if (!q || q.required) return { ok: false, code: 'required' };
      add({ role: 'user', kind: 'skip', questionId: q.id, text: t('claimant.chat.skipped') });
      flow.skip(q.id);
      emit();
      return { ok: true, skip: true };
    },

    /** Add an assistant note to the transcript (for example "we found your policy, but no vehicles on it"). */
    note(text) {
      if (!text) return;
      add({ role: 'assistant', kind: 'note', text });
      emit();
    },

    /**
     * Record the policy vehicle picked before the conversation (S6-RA-08) as the question and the claimant's answer.
     * The question still open stays last, so the claimant sees what to answer next. Picking again replaces the answer.
     */
    recordPicked(questionId, shown) {
      if (!questionId || !shown) return;
      const prior = messages.find((m) => m.kind === 'picked' && m.questionId === questionId);
      if (prior) { prior.text = shown; emit(); return; }
      const q = flow.questionFor?.(questionId);
      const tail = messages.length && messages[messages.length - 1].kind === 'question' ? messages.pop() : null;
      add({ role: 'assistant', kind: 'question', questionId, text: localText(q?.text, locale()) || t('claimant.review.vehicle') });
      add({ role: 'user', kind: 'picked', questionId, text: shown });
      if (tail) messages.push(tail);
      emit();
    },

    /** Confirm an AI-prefilled answer as-is. */
    async confirmSuggestion(questionId) {
      const msg = suggested.get(questionId);
      if (!msg || msg.status !== 'pending') return null;
      msg.status = 'confirmed';
      add({ role: 'user', kind: 'confirm', questionId, text: msg.shown });
      emit();
      const step = await flow.confirmSuggestion(questionId);
      if (!step) failed();
      return step;
    },

    /** Replace an AI-prefilled answer with the claimant's edit. */
    async editSuggestion(questionId, text) {
      const msg = suggested.get(questionId);
      if (!msg || msg.status !== 'pending') return null;
      const q = flow.questionFor?.(questionId) ?? (lastQuestion?.id === questionId ? lastQuestion : { type: 'text' });
      const res = coerceAnswer(q, text, { locale: locale(), today: today() });
      if (!res.ok) {
        add({ role: 'assistant', kind: 'error', text: t(`claimant.chat.${res.code}`, { options: (res.options ?? []).join(', ') }) });
        emit();
        return res;
      }
      msg.status = 'edited';
      add({ role: 'user', kind: 'edit', questionId, text: String(text).trim() });
      emit();
      const step = await flow.confirmSuggestion(questionId, res.value);
      if (!step) failed();
      return step;
    }
  };
}
