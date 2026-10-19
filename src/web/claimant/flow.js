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
 * Sort questions the way the server sequences them: by `order`, then required before optional, then given order.
 * @param {any[]} list
 */
export function orderQuestions(list) {
  return (list ?? []).map((q, i) => ({ q, i }))
    .sort((a, b) => (a.q.order ?? 1e6) - (b.q.order ?? 1e6) || (b.q.required ? 1 : 0) - (a.q.required ? 1 : 0) || a.i - b.i)
    .map((x) => x.q);
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
    insuredVehicleError: null,
    pickedQuestionId: null, // question the policy-vehicle picker answered (not a question the claimant was asked)
    optional: [], // unanswered optional questions the server listed (step.optional)
    hasVehicleQuestion: false, // the session's question set asks for a vehicle (insured vehicle picker applies)
    editing: null, // question id the claimant went back to (Back / Edit)
    stepSeq: 0 // increases on every server step or failure, so views can tell a new error from a re-render
  };
  // Client-side bookkeeping: the server stores answers; skipping an optional question is only a client decision
  // (posting an empty value is a validation error by contract).
  const skipped = new Set();
  const known = new Map(); // questionId -> Question as last seen
  const values = new Map(); // questionId -> value the server accepted
  const history = []; // question ids in the order they were shown
  let lastStep = null;
  const missingText = new Map(); // questionId -> localized text from step.missing (questions not yet asked)

  const snapshot = () => ({
    ...state, progress: { ...state.progress }, suggestions: [...state.suggestions], errors: [...state.errors], optional: [...state.optional],
    skipped: [...skipped], history: [...history], answers: Object.fromEntries(values), canGoBack: canGoBack()
  });
  const emit = () => { const s = snapshot(); for (const l of listeners) l(s); };

  /** Next question to show: the earliest (by `order`) of the required next question and the optional ones not skipped. */
  function pickQuestion(step) {
    if (state.editing && known.has(state.editing)) return known.get(state.editing);
    return orderQuestions([step?.question, ...(Array.isArray(step?.optional) ? step.optional : [])].filter((q) => q && !skipped.has(q.id)))[0] ?? null;
  }

  function recompute() {
    const step = lastStep ?? {};
    state.question = pickQuestion(step);
    state.done = !!step.done;
    state.phase = state.question ? 'asking' : state.done ? 'ready' : 'asking';
    if (state.question && !history.includes(state.question.id)) history.push(state.question.id);
  }

  function applyStep(raw) {
    // By contract step.question is the next *required* question (requiredIf included) and step.optional the optional ones;
    // publicQuestion only carries the static `required` flag, so it is normalized here.
    const step = { ...raw };
    if (step.question) step.question = { ...step.question, required: true };
    if (Array.isArray(step.optional)) step.optional = step.optional.map((q) => ({ ...q, required: false }));
    for (const m of Array.isArray(step.missing) ? step.missing : []) if (m?.questionId && m.text) missingText.set(m.questionId, m.text);
    lastStep = step;
    state.sessionId = step.sessionId ?? state.sessionId;
    for (const q of [step.question, ...(Array.isArray(step.optional) ? step.optional : [])]) if (q?.id) known.set(q.id, q);
    state.optional = Array.isArray(step.optional) ? step.optional : [];
    if ([step.question, ...state.optional].some((q) => q?.type === 'vehicle')) state.hasVehicleQuestion = true;
    state.progress = step.progress ?? state.progress;
    state.suggestions = Array.isArray(step.suggestions) ? step.suggestions : [];
    state.errors = Array.isArray(step.errors) ? step.errors : [];
    if (Array.isArray(step.disclosures) && step.disclosures.length) state.disclosures = step.disclosures;
    state.error = null;
    state.stepSeq += 1;
    recompute();
  }

  function canGoBack() {
    const cur = state.phase === 'ready' && !state.question ? null : state.question?.id;
    const idx = cur ? history.indexOf(cur) : history.length;
    return idx > 0;
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
      state.stepSeq += 1;
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
      skipped.clear(); known.clear(); values.clear(); history.length = 0; lastStep = null; state.editing = null; state.hasVehicleQuestion = false;
      state.pickedQuestionId = null; state.insuredVehicle = null; state.insuredVehicleSent = false; state.insuredVehicleError = null;
      const body = { lob, channel, locale };
      if (lossType) body.lossType = lossType;
      if (policyNumber) body.policyNumber = policyNumber;
      const step = await run('start', { lob, locale, lossType, policyNumber }, () => api.post('/intake/sessions', body), 'starting');
      if (step) applyStep(step);
      emit();
      return step;
    },

    /** Answer one question; server returns the next step. `provenance: 'ai_extraction'` confirms an AI suggestion as-is. */
    async answer(questionId, value, { provenance } = {}) {
      if (!state.sessionId) return null;
      const body = provenance ? { questionId, value, provenance } : { questionId, value };
      const step = await run('answer', { questionId, value, provenance }, () => api.post(`/intake/sessions/${state.sessionId}/answers`, body));
      if (step) {
        values.set(questionId, value); skipped.delete(questionId);
        if (state.editing === questionId) state.editing = null;
        applyStep(step);
      }
      emit();
      return step;
    },

    /** Skip an optional question (client-side: nothing is sent). Required questions cannot be skipped. */
    skip(questionId) {
      const q = known.get(questionId);
      if (!q || q.required) return false;
      // An answer already on the server cannot be blanked (empty values are invalid); skipping it again keeps it.
      if (!values.has(questionId)) skipped.add(questionId);
      if (state.editing === questionId) state.editing = null;
      recompute(); state.errors = []; state.error = null; emit();
      return true;
    },

    /** Go back to the previous question shown (its answer, if any, is kept and offered for change). */
    back() {
      const cur = state.phase === 'ready' && !state.question ? null : state.question?.id;
      const idx = cur ? history.indexOf(cur) : history.length;
      if (idx <= 0) return false;
      return api_.edit(history[idx - 1]);
    },

    /** Re-open an earlier question (review Edit links, browser Back). */
    edit(questionId) {
      if (!known.has(questionId)) return false;
      state.editing = questionId; state.errors = []; state.error = null;
      recompute(); emit();
      return true;
    },

    /** Leave an edit without changing the answer: back to the next open question. */
    cancelEdit() { state.editing = null; recompute(); emit(); },

    /** The Question object last seen for an id (or a text-only stub from step.missing), or null. */
    questionFor(questionId) {
      return known.get(questionId) ?? (missingText.has(questionId) ? { id: questionId, text: missingText.get(questionId) } : null);
    },

    /** Free-text narrative (chat): the server suggests answers (with provider, model, confidence, explanation) for confirmation. */
    async narrative(text) {
      if (!state.sessionId) return null;
      const step = await run('narrative', { text }, () => api.post(`/intake/sessions/${state.sessionId}/narrative`, { text }));
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
        values.set(qid, answer); skipped.delete(qid);
        // S6-RA-09: only a question of the set counts toward the server's progress; remember it so the view can leave it out.
        state.pickedQuestionId = known.has(qid) ? qid : null;
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
      if (step) {
        const bad = new Set((step.errors ?? []).map((e) => e.questionId));
        for (const a of answers) if (!bad.has(a.questionId)) { values.set(a.questionId, a.value); skipped.delete(a.questionId); }
        applyStep(step);
      }
      emit();
      return step;
    },

    /** Confirm an AI suggestion as-is, or with an edited value. */
    async confirmSuggestion(questionId, value) {
      const s = state.suggestions.find((x) => x.questionId === questionId);
      if (!s) return null;
      // Unedited: confirm with provenance so the claim records the AI source and confidence; edited: the claimant's own answer.
      return value === undefined ? api_.answer(questionId, s.value, { provenance: 'ai_extraction' }) : api_.answer(questionId, value);
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
      if (kind === 'answer') return api_.answer(args.questionId, args.value, { provenance: args.provenance });
      if (kind === 'narrative') return api_.narrative(args.text);
      if (kind === 'answerMany') return api_.answerMany(args.answers);
      if (kind === 'refresh') return api_.refresh();
      if (kind === 'submit') return api_.submit();
      return null;
    },

    hasPendingRetry() { return !!pending; },
    /** Back to the start screen. */
    reset() { pending = null; submitKey = null; skipped.clear(); known.clear(); values.clear(); history.length = 0; lastStep = null; Object.assign(state, { phase: 'idle', sessionId: null, question: null, suggestions: [], errors: [], done: false, claim: null, error: null, busy: false, optional: [], editing: null, hasVehicleQuestion: false, pickedQuestionId: null, insuredVehicle: null, insuredVehicleSent: false, insuredVehicleError: null, progress: { answered: 0, requiredRemaining: 0, percent: 0 } }); emit(); }
  };
  return api_;
}
