// Conversational mode: a transcript built on top of the intake flow.
// Free-text answers are coerced to the question type, AI prefills need confirm/edit.
import { localText } from './strings.js';

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
  switch (question?.type) {
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
export function displayValue(question, value, locale = 'en') {
  if (Array.isArray(value)) return value.map((v) => displayValue(question, v, locale)).join(', ');
  const opt = question?.options?.find((o) => o.value === value);
  if (opt) return localText(opt.label, locale);
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

/**
 * Create the chat controller.
 * @param {{ flow: any, t: Function, locale?: () => string }} deps
 */
export function createChat({ flow, t, locale = () => 'en' }) {
  const listeners = new Set();
  /** @type {any[]} */
  const messages = [];
  let seq = 0;
  let lastAsked = null;
  const suggested = new Map(); // questionId -> message
  let doneAnnounced = false;
  let lastQuestion = null;

  const emit = () => { const m = messages.map((x) => ({ ...x })); for (const l of listeners) l(m); };
  const add = (msg) => { const m = { id: `m${++seq}`, ...msg }; messages.push(m); return m; };

  function onState(s) {
    const loc = locale();
    if (s.question) lastQuestion = s.question;
    if (s.question && s.question.id !== lastAsked && s.phase !== 'starting') {
      lastAsked = s.question.id;
      add({ role: 'assistant', kind: 'question', questionId: s.question.id, text: localText(s.question.text, loc), help: localText(s.question.help, loc) });
    }
    for (const sg of s.suggestions) {
      const prior = suggested.get(sg.questionId);
      if (prior && prior.status === 'pending') continue;
      if (prior && prior.status !== 'pending' && prior.value === sg.value) continue;
      const q = lastQuestion?.id === sg.questionId ? lastQuestion : null;
      const msg = add({ role: 'assistant', kind: 'suggestion', questionId: sg.questionId, value: sg.value, shown: displayValue(q, sg.value, loc), ai: sg.ai ?? null, status: 'pending', text: t('claimant.chat.suggested', { value: displayValue(q, sg.value, loc) }) });
      suggested.set(sg.questionId, msg);
    }
    // drop suggestions the server no longer lists
    for (const [qid, msg] of suggested) if (msg.status === 'pending' && !s.suggestions.some((x) => x.questionId === qid)) msg.status = 'dismissed';
    for (const e of s.errors) add({ role: 'assistant', kind: 'error', questionId: e.questionId, text: e.message });
    if (s.phase === 'ready' && !doneAnnounced) { doneAnnounced = true; add({ role: 'assistant', kind: 'done', text: t('claimant.chat.done') }); }
    emit();
  }
  flow.subscribe(onState);

  const answerFor = async (questionId, value, shown, kind = 'answer') => {
    add({ role: 'user', kind, questionId, text: shown });
    emit();
    const step = await flow.answer(questionId, value);
    if (!step && flow.state.phase !== 'unavailable') {
      add({ role: 'assistant', kind: 'error', text: flow.state.error?.message ?? '' });
      emit();
    }
    return step;
  };

  return {
    get messages() { return messages.map((x) => ({ ...x })); },
    subscribe(fn) { listeners.add(fn); fn(messages.map((x) => ({ ...x }))); return () => listeners.delete(fn); },

    /** Send a free-text answer for the current question. */
    async sendText(text) {
      const q = flow.state.question;
      if (!q) return { ok: false, code: 'noQuestion' };
      const res = coerceAnswer(q, text, { locale: locale() });
      if (!res.ok) {
        if (res.code !== 'empty') add({ role: 'user', kind: 'answer', text: String(text).trim() });
        add({ role: 'assistant', kind: 'error', text: t(`claimant.chat.${res.code}`, { options: (res.options ?? []).join(', ') }) });
        emit();
        return res;
      }
      await answerFor(q.id, res.value, String(text).trim());
      return { ok: true, value: res.value };
    },

    /** Confirm an AI-prefilled answer as-is. */
    async confirmSuggestion(questionId) {
      const msg = suggested.get(questionId);
      if (!msg || msg.status !== 'pending') return null;
      msg.status = 'confirmed';
      add({ role: 'user', kind: 'confirm', questionId, text: msg.shown });
      emit();
      return flow.confirmSuggestion(questionId);
    },

    /** Replace an AI-prefilled answer with the claimant's edit. */
    async editSuggestion(questionId, text) {
      const msg = suggested.get(questionId);
      if (!msg || msg.status !== 'pending') return null;
      const q = lastQuestion?.id === questionId ? lastQuestion : { type: 'text' };
      const res = coerceAnswer(q, text, { locale: locale() });
      if (!res.ok) {
        add({ role: 'assistant', kind: 'error', text: t(`claimant.chat.${res.code}`, { options: (res.options ?? []).join(', ') }) });
        emit();
        return res;
      }
      msg.status = 'edited';
      add({ role: 'user', kind: 'edit', questionId, text: String(text).trim() });
      emit();
      return flow.confirmSuggestion(questionId, res.value);
    }
  };
}
