// Assisted intake controller for CSRs. Pure logic: inject { api, t, clock, random }. No kit imports.
// The server owns showIf/requiredIf; this module only follows the IntakeStep it returns.
import { isUnavailable, resolveI18n } from './errors.js';

/** Contract channel for CSR-assisted calls (common.schema.json Channel enum). */
export const CSR_CHANNEL = 'csr_phone';

/**
 * Build the scripted prompt for a question from its text and help text. Pure.
 * @returns {{ ask: string, help: string, text: string }}
 */
export function scriptedPrompt(question, { t, locale = 'en' }) {
  if (!question) return { ask: '', help: '', text: t('csr.script.done') };
  const ask = t('csr.script.ask', { text: resolveI18n(question.text, locale) });
  const helpRaw = resolveI18n(question.help, locale);
  const help = helpRaw ? t('csr.script.help', { help: helpRaw }) : '';
  return { ask, help, text: help ? `${ask} ${help}` : ask };
}

/**
 * Required items still missing. IntakeStep carries only a count (progress.requiredRemaining),
 * so unless the server sends an optional `missing[]` (contract-change requested) the list is derived
 * from the questions seen so far; `unlisted` is the remaining count not yet known by name.
 * @param {{ question?: any, progress?: any, missing?: any[] }} step
 * @param {Map<string, {id:string,text:any,required:boolean}>} seen
 * @param {Set<string>} answered
 */
export function deriveMissing(step, seen, answered, locale = 'en') {
  const remaining = step?.progress?.requiredRemaining ?? 0;
  let items;
  if (Array.isArray(step?.missing)) {
    items = step.missing.map((m) => (typeof m === 'string' ? { id: m, text: m } : { id: m.questionId ?? m.id, text: resolveI18n(m.text ?? m.label ?? m.questionId ?? m.id, locale) }));
  } else {
    items = [...seen.values()]
      .filter((q) => q.required && !answered.has(q.id))
      .map((q) => ({ id: q.id, text: resolveI18n(q.text, locale) }));
  }
  return { items, unlisted: Math.max(0, remaining - items.length) };
}

/**
 * @param {{ api: any, t: (k:string,p?:object)=>string, clock?: {now():number}, random?: ()=>number, channel?: string }} deps
 */
export function createAssistedIntake({ api, t, clock = { now: () => Date.now() }, random = Math.random, channel = CSR_CHANNEL }) {
  const listeners = new Set();
  const seen = new Map();
  const answered = new Set();
  let pending = null;
  let submitKey = null;
  const state = {
    phase: 'idle', // idle | starting | asking | ready | submitting | submitted | unavailable | failed
    sessionId: null, policyNumber: null, lob: null, locale: 'en',
    question: null, progress: { answered: 0, requiredRemaining: 0, percent: 0 },
    missing: [], unlisted: 0, script: { ask: '', help: '', text: '' },
    disclosures: [], errors: [], done: false, claim: null, error: null, busy: false,
  };
  const snap = () => ({ ...state, progress: { ...state.progress }, missing: [...state.missing], errors: [...state.errors], disclosures: [...state.disclosures] });
  const emit = () => { const s = snap(); for (const l of listeners) l(s); };

  function apply(step) {
    state.sessionId = step.sessionId ?? state.sessionId;
    state.question = step.question ?? null;
    state.done = !!step.done;
    state.progress = step.progress ?? state.progress;
    state.errors = Array.isArray(step.errors) ? step.errors : [];
    if (Array.isArray(step.disclosures) && step.disclosures.length) state.disclosures = step.disclosures;
    if (state.question) seen.set(state.question.id, { id: state.question.id, text: state.question.text, required: state.question.required !== false });
    const m = deriveMissing(step, seen, answered, state.locale);
    state.missing = m.items; state.unlisted = m.unlisted;
    state.script = scriptedPrompt(state.question, { t, locale: state.locale });
    state.phase = state.question ? 'asking' : state.done ? 'ready' : 'asking';
    state.error = null;
  }

  async function run(kind, args, fn, busyPhase) {
    const before = state.phase;
    if (busyPhase) state.phase = busyPhase;
    state.busy = true; state.error = null; emit();
    try {
      const out = await fn();
      pending = null; state.busy = false;
      return out;
    } catch (err) {
      state.busy = false;
      state.error = { code: err?.code ?? 'error', message: err?.message ?? String(err), status: err?.status };
      if (isUnavailable(err)) { pending = { kind, args, before }; state.phase = 'unavailable'; }
      else { pending = null; state.phase = before; }
      emit();
      return null;
    }
  }

  const self = {
    get state() { return snap(); },
    subscribe(fn) { listeners.add(fn); fn(snap()); return () => listeners.delete(fn); },

    /** Start a CSR session for a policy: POST /intake/sessions {lob, channel, policyNumber}. */
    async start({ lob, policyNumber, locale = 'en', lossType } = {}) {
      seen.clear(); answered.clear(); submitKey = null;
      Object.assign(state, { lob, policyNumber, locale, claim: null, sessionId: null });
      const body = { lob, channel, locale, policyNumber };
      if (lossType) body.lossType = lossType;
      const step = await run('start', { lob, policyNumber, locale, lossType }, () => api.post('/intake/sessions', body), 'starting');
      if (step) apply(step);
      emit();
      return step;
    },

    /** Answer the current (or a named) question. */
    async answer(questionId, value) {
      if (!state.sessionId) return null;
      const step = await run('answer', { questionId, value }, () => api.post(`/intake/sessions/${state.sessionId}/answers`, { questionId, value }));
      if (step) { answered.add(questionId); apply(step); }
      emit();
      return step;
    },

    /** Re-fetch the current step. */
    async refresh() {
      if (!state.sessionId) return null;
      const step = await run('refresh', {}, () => api.get(`/intake/sessions/${state.sessionId}/next-question`));
      if (step) apply(step);
      emit();
      return step;
    },

    /** Submit; one Idempotency-Key per session is reused across retries so a claim is created once. */
    async submit() {
      if (!state.sessionId || !state.done) return null;
      submitKey ??= `csr-${state.sessionId}-${clock.now().toString(36)}-${Math.floor(random() * 1e9).toString(36)}`;
      const key = submitKey;
      const claim = await run('submit', {}, () => api.post(`/intake/sessions/${state.sessionId}/submit`, {}, { headers: { 'Idempotency-Key': key } }), 'submitting');
      if (claim) { state.claim = claim; state.phase = 'submitted'; }
      emit();
      return claim;
    },

    /** Re-run whatever failed with "service unavailable". */
    async retry() {
      if (!pending) return null;
      const { kind, args, before } = pending;
      if (state.phase === 'unavailable') state.phase = before;
      if (kind === 'start') return self.start(args);
      if (kind === 'answer') return self.answer(args.questionId, args.value);
      if (kind === 'refresh') return self.refresh();
      if (kind === 'submit') return self.submit();
      return null;
    },

    reset() {
      seen.clear(); answered.clear(); submitKey = null; pending = null;
      Object.assign(state, { phase: 'idle', sessionId: null, policyNumber: null, lob: null, question: null, missing: [], unlisted: 0, script: { ask: '', help: '', text: '' }, disclosures: [], errors: [], done: false, claim: null, error: null, busy: false, progress: { answered: 0, requiredRemaining: 0, percent: 0 } });
      emit();
    },
  };
  return self;
}

/** Link to open a claim read-only in the CSR portal. */
export function claimLink(claim) {
  return claim?.id ? `/csr?claim=${encodeURIComponent(claim.id)}` : '';
}
