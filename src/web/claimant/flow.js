// Intake flow state machine. Pure logic: the server owns showIf/requiredIf, so this
// module only follows the IntakeStep the API returns. Inject { api, t, clock, timers }.

export const CHANNEL = 'claimant_web';

/**
 * True when an error means the backend (or a route) is not reachable.
 * @param {any} err
 */
export function isUnavailable(err, { sessionScoped = false } = {}) {
  if (!err) return false;
  if (err.code === 'service_unavailable') return true;
  if (typeof err.status === 'number') return err.status >= 500 || (err.status === 404 && (err.code === 'route_not_found' || !sessionScoped));
  return true; // thrown without a status: network failure
}

/**
 * Create a flow controller.
 * @param {{ api: any, clock?: { now(): number }, random?: () => number, channel?: string }} deps
 */
export function createIntakeFlow({ api, clock = { now: () => Date.now() }, random = Math.random, channel = CHANNEL }) {
  const listeners = new Set();
  let pending = null; // last action that failed with "unavailable", for retry()
  let submitKey = null;
  const state = {
    phase: 'idle', // idle | starting | asking | ready | submitting | submitted | unavailable | failed
    sessionId: null,
    lob: null,
    locale: 'en',
    question: null,
    progress: { answered: 0, requiredRemaining: 0, percent: 0 },
    suggestions: [],
    errors: [],
    disclosures: [],
    done: false,
    claim: null,
    error: null,
    busy: false,
    insuredVehicle: null,
    insuredVehicleSent: false,
    insuredVehicleError: null
  };

  const snapshot = () => ({ ...state, progress: { ...state.progress }, suggestions: [...state.suggestions], errors: [...state.errors] });
  const emit = () => { const s = snapshot(); for (const l of listeners) l(s); };

  function applyStep(step) {
    state.sessionId = step.sessionId ?? state.sessionId;
    state.question = step.question ?? null;
    state.done = !!step.done;
    state.progress = step.progress ?? state.progress;
    state.suggestions = Array.isArray(step.suggestions) ? step.suggestions : [];
    state.errors = Array.isArray(step.errors) ? step.errors : [];
    if (Array.isArray(step.disclosures) && step.disclosures.length) state.disclosures = step.disclosures;
    state.phase = state.question ? 'asking' : state.done ? 'ready' : 'asking';
    state.error = null;
  }

  async function run(kind, args, fn, busyPhase) {
    const before = state.phase;
    if (busyPhase) state.phase = busyPhase;
    state.busy = true; state.error = null; emit();
    try {
      const out = await fn();
      pending = null;
      state.busy = false;
      return out;
    } catch (err) {
      state.busy = false;
      state.error = { code: err?.code ?? 'error', message: err?.message ?? String(err), status: err?.status };
      // A 422 carries the step with per-question errors[]; the app adapter attaches them as err.errors.
      if (Array.isArray(err?.errors)) state.errors = err.errors;
      if (isUnavailable(err, { sessionScoped: kind !== 'start' })) {
        pending = { kind, args, before };
        state.phase = 'unavailable';
      } else {
        pending = null;
        state.phase = before;
      }
      emit();
      return null;
    }
  }

  const api_ = {
    get state() { return snapshot(); },
    subscribe(fn) { listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); },

    /** Start a session. */
    async start({ lob, locale = 'en', lossType, policyNumber } = {}) {
      state.lob = lob; state.locale = locale; state.claim = null; submitKey = null;
      const body = { lob, channel, locale };
      if (lossType) body.lossType = lossType;
      if (policyNumber) body.policyNumber = policyNumber;
      const step = await run('start', { lob, locale, lossType, policyNumber }, () => api.post('/intake/sessions', body), 'starting');
      if (step) applyStep(step);
      emit();
      return step;
    },

    /** Answer one question; server returns the next step. */
    async answer(questionId, value) {
      if (!state.sessionId) return null;
      const step = await run('answer', { questionId, value }, () => api.post(`/intake/sessions/${state.sessionId}/answers`, { questionId, value }));
      if (step) applyStep(step);
      emit();
      return step;
    },

    /**
     * Record the insured vehicle picked from the policy (policyVehicleId and VIN included). Sent to the tenant's vehicle-type
     * question when it is the current one, else to 'insured_vehicle'. A rejection (no such question) is not an error here.
     */
    async setInsuredVehicle(answer, questionId = 'insured_vehicle') {
      state.insuredVehicle = answer ?? null; state.insuredVehicleSent = false; state.insuredVehicleError = null;
      if (!answer || !state.sessionId) { emit(); return null; }
      const qid = state.question?.type === 'vehicle' ? state.question.id : questionId;
      try {
        const step = await api.post(`/intake/sessions/${state.sessionId}/answers`, { questionId: qid, value: answer });
        applyStep(step); state.insuredVehicleSent = true; state.insuredVehicleError = null;
        emit();
        return step;
      } catch (err) {
        state.insuredVehicleError = err?.errors?.[0]?.message ?? err?.message ?? 'Request failed.';
        emit();
        return null;
      }
    },

    /** Answer several at once (used to confirm AI suggestions). */
    async answerMany(answers) {
      if (!state.sessionId) return null;
      const step = await run('answerMany', { answers }, () => api.post(`/intake/sessions/${state.sessionId}/answers`, { answers }));
      if (step) applyStep(step);
      emit();
      return step;
    },

    /** Confirm an AI suggestion as-is, or with an edited value. */
    async confirmSuggestion(questionId, value) {
      const s = state.suggestions.find((x) => x.questionId === questionId);
      if (!s) return null;
      return api_.answer(questionId, value === undefined ? s.value : value);
    },

    /** Re-fetch the current step (after reload or retry). */
    async refresh() {
      if (!state.sessionId) return null;
      const step = await run('refresh', {}, () => api.get(`/intake/sessions/${state.sessionId}/next-question`));
      if (step) applyStep(step);
      emit();
      return step;
    },

    /** Submit the session. The Idempotency-Key is reused across retries so a claim is created once. */
    async submit() {
      if (!state.sessionId || !state.done) return null;
      submitKey ??= `claimant-${state.sessionId}-${clock.now().toString(36)}-${Math.floor(random() * 1e9).toString(36)}`;
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
      if (kind === 'start') return api_.start(args);
      if (kind === 'answer') return api_.answer(args.questionId, args.value);
      if (kind === 'answerMany') return api_.answerMany(args.answers);
      if (kind === 'refresh') return api_.refresh();
      if (kind === 'submit') return api_.submit();
      return null;
    },

    hasPendingRetry() { return !!pending; },
    /** Back to the start screen. */
    reset() { pending = null; submitKey = null; Object.assign(state, { phase: 'idle', sessionId: null, question: null, suggestions: [], errors: [], done: false, claim: null, error: null, busy: false, progress: { answered: 0, requiredRemaining: 0, percent: 0 } }); emit(); }
  };
  return api_;
}
