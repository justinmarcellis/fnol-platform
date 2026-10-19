// Assisted intake controller for CSRs. Pure logic: inject { api, t, clock, random }. No kit imports.
// The server owns showIf/requiredIf; this module only follows the IntakeStep it returns.
import { isUnavailable, resolveI18n } from './errors.js';
import { INSURED_VEHICLE_QUESTION } from './answers.js';

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
 * The question to put on screen: the server's next required question or an optional one (IntakeStep.optional[]) the
 * caller has not answered or skipped, whichever comes first in the question set order. Optional questions handled by
 * another control (the insured-vehicle picker) are left out. Pure.
 * @param {{ question?: any, optional?: any[] }} step
 * @param {{ answered?: Set<string>, skipped?: Set<string>, external?: Set<string> }} sets
 */
export function nextQuestion(step, { answered = new Set(), skipped = new Set(), external = new Set() } = {}) {
  const req = step?.question ?? null;
  const opts = (Array.isArray(step?.optional) ? step.optional : [])
    .filter((q) => q?.id && !answered.has(q.id) && !skipped.has(q.id) && !external.has(q.id) && q.id !== req?.id)
    .map((q) => ({ ...q, required: false }));
  const ord = (q) => (Number.isFinite(Number(q?.order)) ? Number(q.order) : Number.MAX_SAFE_INTEGER);
  let best = req;
  for (const q of opts) if (!best || ord(q) < ord(best)) best = q;
  return best;
}

/**
 * Loss types the tenant offers for a line of business (GET /config/public lobs[].lossTypes) as select options. Pure.
 * S6-RA-02: the desk must send one when it starts the session, else the claim has no lossType and its cause falls
 * back to 'other' (coverage needs_review "cause_not_mapped", no subrogation recovery task).
 * @param {{ id: string, lossTypes?: { id: string, label?: any }[] }[]} lobs
 * @param {string} lob
 * @returns {{ value: string, label: string }[]}
 */
export function lossTypeOptions(lobs, lob, locale = 'en') {
  const cfg = (Array.isArray(lobs) ? lobs : []).find((l) => l?.id === lob);
  return (Array.isArray(cfg?.lossTypes) ? cfg.lossTypes : [])
    .filter((x) => x && typeof x.id === 'string' && x.id)
    .map((x) => ({ value: x.id, label: resolveI18n(x.label, locale) || x.id }));
}

/** The loss type to start with: the one asked for when the tenant offers it, else the tenant's first. Pure. */
export function initialLossType(options, wanted) {
  const list = Array.isArray(options) ? options : [];
  if (wanted && list.some((o) => o.value === wanted)) return wanted;
  return list[0]?.value;
}

/**
 * @param {{ api: any, t: (k:string,p?:object)=>string, clock?: {now():number}, random?: ()=>number, channel?: string }} deps
 */
export function createAssistedIntake({ api, t, clock = { now: () => Date.now() }, random = Math.random, channel = CSR_CHANNEL }) {
  const listeners = new Set();
  const seen = new Map();
  const answered = new Set();
  const skipped = new Set();
  const external = new Set();
  let lastStep = null;
  let pending = null;
  let submitKey = null;
  const state = {
    phase: 'idle', // idle | starting | asking | ready | submitting | submitted | unavailable | failed
    sessionId: null, policyNumber: null, lob: null, lossType: null, channel: null, locale: 'en',
    question: null, optional: [], vehicleQuestionId: null, progress: { answered: 0, requiredRemaining: 0, percent: 0 },
    missing: [], unlisted: 0, script: { ask: '', help: '', text: '' },
    disclosures: [], errors: [], done: false, claim: null, error: null, busy: false,
    insuredVehicle: null, insuredVehicleSent: false, insuredVehicleError: null,
  };
  const snap = () => ({ ...state, progress: { ...state.progress }, missing: [...state.missing], errors: [...state.errors], disclosures: [...state.disclosures], optional: [...state.optional] });
  const emit = () => { const s = snap(); for (const l of listeners) l(s); };

  function apply(step) {
    lastStep = step;
    state.sessionId = step.sessionId ?? state.sessionId;
    for (const q of [step.question, ...(Array.isArray(step.optional) ? step.optional : [])]) {
      if (q?.type === 'vehicle' && !state.vehicleQuestionId) state.vehicleQuestionId = q.id;
    }
    state.optional = (Array.isArray(step.optional) ? step.optional : []).filter((q) => q?.id && !answered.has(q.id));
    state.question = nextQuestion(step, { answered, skipped, external });
    state.done = !!step.done;
    state.progress = step.progress ?? state.progress;
    state.errors = Array.isArray(step.errors) ? step.errors : [];
    if (Array.isArray(step.disclosures) && step.disclosures.length) state.disclosures = step.disclosures;
    if (state.question) seen.set(state.question.id, { id: state.question.id, type: state.question.type, text: state.question.text, required: state.question.required !== false });
    for (const q of state.optional) if (!seen.has(q.id)) seen.set(q.id, { id: q.id, type: q.type, text: q.text, required: false });
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
      // A 422 carries the step with per-question errors[]; the app adapter attaches them as err.errors.
      if (Array.isArray(err?.errors)) state.errors = err.errors;
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
    async start({ lob, policyNumber, locale = 'en', lossType, channel: ch } = {}) {
      seen.clear(); answered.clear(); skipped.clear(); external.clear(); lastStep = null; submitKey = null;
      Object.assign(state, { lob, policyNumber, locale, lossType: lossType ?? null, channel: ch ?? channel, claim: null, sessionId: null, optional: [], vehicleQuestionId: null });
      const body = { lob, channel: ch ?? channel, locale, policyNumber };
      if (lossType) body.lossType = lossType;
      const step = await run('start', { lob, policyNumber, locale, lossType, channel: ch }, () => api.post('/intake/sessions', body), 'starting');
      if (step) apply(step);
      emit();
      return step;
    },

    /** True while the loss type can still change: a session exists and nothing has been answered in it. */
    get canChangeLossType() { return !!state.sessionId && answered.size === 0 && !state.busy && state.phase !== 'submitted'; },

    /**
     * Switch the loss type before the first answer: starts a fresh session for the same policy, line and channel with
     * the new lossType (the tenant may ask a different question set, e.g. glass). Questions handled by another control
     * stay handled. Returns null (and changes nothing) once an answer has been recorded.
     */
    async changeLossType(lossType) {
      if (!lossType || lossType === state.lossType) return lastStep;
      if (!self.canChangeLossType) return null;
      const keep = [...external];
      const step = await self.start({ lob: state.lob, policyNumber: state.policyNumber, locale: state.locale, lossType, channel: state.channel });
      if (step && keep.length) self.setExternal(keep);
      return step;
    },

    /**
     * Answer the current (or a named) question. An empty answer to an optional question skips it (nothing is sent:
     * the server would refuse a blank value).
     */
    async answer(questionId, value) {
      if (!state.sessionId) return null;
      const q = state.question?.id === questionId ? state.question : null;
      const blank = value === '' || value == null || (Array.isArray(value) && !value.length);
      if (q && q.required === false && blank) return self.skip(questionId);
      const step = await run('answer', { questionId, value }, () => api.post(`/intake/sessions/${state.sessionId}/answers`, { questionId, value }));
      if (step) { answered.add(questionId); apply(step); }
      emit();
      return step;
    },

    /**
     * Record the insured vehicle picked from the policy (answer carries policyVehicleId and VIN). Sent as the answer to the
     * tenant's vehicle-type question when one has been seen (else the 'insured_vehicle' id). A rejected answer is kept in state
     * (`insuredVehicleError`, `insuredVehicleSent` false) so the UI can show it; it never throws.
     */
    async setInsuredVehicle(answer, questionId = INSURED_VEHICLE_QUESTION) {
      state.insuredVehicle = answer ?? null; state.insuredVehicleSent = false; state.insuredVehicleError = null;
      if (!answer || !state.sessionId) { emit(); return null; }
      const qid = state.vehicleQuestionId ?? [...seen.values()].find((x) => x.type === 'vehicle')?.id ?? questionId;
      try {
        const step = await api.post(`/intake/sessions/${state.sessionId}/answers`, { questionId: qid, value: answer });
        answered.add(qid); apply(step); state.insuredVehicleSent = true; state.insuredVehicleError = null;
        emit();
        return step;
      } catch (err) {
        state.insuredVehicleError = err?.errors?.[0]?.message ?? err?.message ?? 'Request failed.';
        emit();
        return null;
      }
    },

    /** Pass over an optional question (no server call). Required questions cannot be skipped. */
    skip(questionId) {
      const q = state.question;
      if (!q || q.id !== questionId || q.required !== false || !lastStep) return null;
      skipped.add(questionId);
      apply(lastStep);
      emit();
      return lastStep;
    },

    /**
     * Mark optional questions as handled by another control (the insured-vehicle picker), so they are not asked in
     * the script as well. Pass [] to clear.
     */
    setExternal(ids = []) {
      external.clear();
      for (const id of ids) if (id) external.add(id);
      if (lastStep) apply(lastStep);
      emit();
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
      seen.clear(); answered.clear(); skipped.clear(); external.clear(); lastStep = null; submitKey = null; pending = null;
      Object.assign(state, { phase: 'idle', sessionId: null, policyNumber: null, lob: null, lossType: null, channel: null, question: null, optional: [], vehicleQuestionId: null, missing: [], unlisted: 0, script: { ask: '', help: '', text: '' }, disclosures: [], errors: [], done: false, claim: null, error: null, busy: false, insuredVehicle: null, insuredVehicleSent: false, insuredVehicleError: null, progress: { answered: 0, requiredRemaining: 0, percent: 0 } });
      emit();
    },
  };
  return self;
}

/** Link to open a claim read-only in the CSR portal. */
export function claimLink(claim) {
  return claim?.id ? `/csr?claim=${encodeURIComponent(claim.id)}` : '';
}
