// Intake service (modules.md#intake): sessions, question engine, conversational prefill, submit.
// ctx is tenant-bound (ctx.tenant.id). Answers are encrypted at rest; logs and audit carry ids and codes only.
import { applicable, buildFacts, localize, plan, publicQuestion, validateAnswer } from './questions.js';
import { suggestFromNarrative } from './conversation.js';
import { toClaimCreate } from './mapping.js';
import * as mapping from './mapping.js';
import { answerBytes, checkAnswerSize, namespacedKey, openSuggestions, sealSuggestions } from './security.js';

const DEFAULT_TTL_MIN = 60;
const MAX_BATCH = 100;
const CHANNEL_ALIASES = { csr: 'csr_phone' };
const SYSTEM_ACTOR = { type: 'system', id: 'intake' };

/** @param {object} ctx tenant-bound ctx */
export function createService(ctx, opts = {}) {
  const mod = (n) => ctx.modules[n];
  const cfg = () => mod('config').getTenantConfig();
  const evalCond = (c, f) => mod('rules').evaluateCondition(c, f);
  const nowIso = () => ctx.clock.nowIso();
  const err = (code, message, status) => new ctx.AppError(code, message, status);
  const actorLabel = (a) => `${a?.type ?? 'system'}:${a?.id ?? 'anonymous'}`;
  const audit = (actor, action, id, details) =>
    ctx.audit.record({ actor: actorLabel(actor), action, entityType: 'intake_session', entityId: id, details });

  // ------------------------------------------------------------ persistence

  function loadRow(sessionId) {
    const row = ctx.db.get('SELECT * FROM intake_sessions WHERE id = ?', sessionId);
    if (!row) throw err('not_found', 'Intake session not found', 404);
    return row;
  }

  // doc.suggestions are PII (narrative text): stored sealed as doc.suggestionsEnc, open in memory only (SEC3-004).
  function docOf(row) {
    const raw = ctx.db.parseJson(row.doc, {});
    const { suggestionsEnc, ...rest } = raw;
    const doc = { ...rest, status: row.status, expiresAt: row.expires_at, updatedAt: row.updated_at };
    if (suggestionsEnc) { const open = openSuggestions(ctx, suggestionsEnc); if (open.length) doc.suggestions = open; }
    return doc;
  }

  function readAnswers(sessionId) {
    const out = {};
    for (const r of ctx.db.all('SELECT * FROM intake_answers WHERE session_id = ?', sessionId)) {
      const meta = ctx.db.parseJson(r.provenance, {});
      const rec = { value: JSON.parse(ctx.crypto.decryptPii(r.value_enc)), answeredAt: r.answered_at };
      if (meta.provenance) rec.provenance = meta.provenance;
      if (meta.confidence !== undefined) rec.confidence = meta.confidence;
      out[r.question_id] = rec;
    }
    return out;
  }

  function saveDoc(sessionId, doc, extra = {}) {
    const { status, expiresAt, updatedAt, suggestions, ...rest } = doc;
    if (suggestions?.length && status === 'active') rest.suggestionsEnc = sealSuggestions(ctx, suggestions);
    const patch = { doc: ctx.db.toJson(rest), status, updated_at: updatedAt ?? nowIso(), expires_at: expiresAt, ...extra };
    ctx.db.update('intake_sessions', sessionId, patch);
  }

  /**
   * Producer check for the `agent` role: does this agent produce the session's policy? Injectable via
   * createService(ctx, { coverageLookup }) with signature ({ policyNumber, asOf, actor, tenantId }) => boolean|Promise<boolean>.
   * Default reads the coverage snapshot producer (producer.agentId | producer.id | producerId | agentId). Fail closed on any problem.
   */
  async function producesPolicy(doc, actor) {
    if (!doc.policyNumber || !actor?.id) return false;
    try {
      const q = { policyNumber: doc.policyNumber, asOf: (doc.startedAt ?? nowIso()).slice(0, 10), actor, tenantId: ctx.tenant.id };
      if (typeof opts.coverageLookup === 'function') return (await opts.coverageLookup(q)) === true;
      const snap = await mod('coverage')?.getPolicySnapshot?.({ policyNumber: q.policyNumber, asOf: q.asOf });
      const p = snap?.producer ?? {};
      const id = p.agentId ?? p.id ?? snap?.producerId ?? snap?.agentId;
      return typeof id === 'string' && id === actor.id;
    } catch { return false; }
  }

  async function assertAccess(doc, actor) {
    // csr and integration (and platform staff) act tenant-wide. Claimants reach only sessions they started.
    // Agents reach sessions they started or sessions on policies they produce. Everyone else gets 404.
    const role = actor?.role;
    if (!actor || role === 'csr' || role === 'csr_phone' || role === 'integration' || role === 'platform_admin') return;
    if (doc.startedBy?.id !== undefined && doc.startedBy.id === actor.id) return;
    if (role === 'agent' && await producesPolicy(doc, actor)) return;
    throw err('not_found', 'Intake session not found', 404);
  }

  const ttlMs = () => (cfg().security?.sessionTtlMinutes ?? DEFAULT_TTL_MIN) * 60000;
  const newExpiry = () => new Date(ctx.clock.now().getTime() + ttlMs()).toISOString();

  /** Load a session, lazily expiring it. Returns { doc, set, answers }. */
  async function load(sessionId, actor) {
    const row = loadRow(sessionId);
    const doc = docOf(row);
    await assertAccess(doc, actor);
    if (doc.status === 'active' && doc.expiresAt && doc.expiresAt < nowIso()) {
      doc.status = 'expired';
      delete doc.suggestions;
      saveDoc(sessionId, doc);
    }
    const set = (cfg().questionSets ?? []).find((s) => s.id === doc.questionSetId);
    if (doc.status === 'active' && !set) {
      doc.status = 'expired';
      delete doc.suggestions;
      saveDoc(sessionId, doc);
    }
    if (set && set.version !== doc.questionSetVersion) doc.questionSetVersion = set.version;
    return { doc, set, answers: readAnswers(sessionId) };
  }

  function requireActive(doc) {
    if (doc.status === 'active') return;
    throw err(doc.status === 'expired' ? 'session_expired' : 'session_not_active', `Intake session is ${doc.status}`, 409);
  }

  // ------------------------------------------------------------ question engine

  /** Evaluate applicable questions, intake-stage rules and progress. */
  async function evaluateState(doc, set, answers) {
    const facts = buildFacts(doc, answers);
    const forced = new Set();
    const blocks = [];
    if (typeof mod('rules')?.evaluate === 'function') {
      const res = await mod('rules').evaluate({ stage: 'intake', facts, lob: doc.lob, lossType: doc.lossType });
      for (const a of res?.actions ?? []) {
        if (a.type === 'require_question' && a.questionId) forced.add(a.questionId);
        if (a.type === 'block_submit') blocks.push(a.message ?? a.reason ?? 'blocked_by_rule');
      }
    }
    const { visible, required } = applicable(set, facts, evalCond, forced);
    return { facts, visible, required, blocks, ...plan(visible, required, answers) };
  }

  function disclosures(doc, answers) {
    const warn = cfg().branding?.fraudWarning ?? {};
    const st = answers.risk_state?.value ?? answers.loss_state?.value;
    const keys = st && warn[st] ? [st] : Object.keys(warn);
    return keys.map((k) => localize(warn[k], doc.locale));
  }

  async function buildStep(sessionId, doc, set, answers, { errors, suggestions } = {}) {
    const st = await evaluateState(doc, set, answers);
    const q = st.next;
    const sugg = suggestions ?? doc.suggestions ?? [];
    const step = {
      sessionId,
      done: st.remaining.length === 0 && st.blocks.length === 0,
      question: q ? publicQuestion(q) : null,
      prompt: q ? localize(q.text, doc.locale) : null,
      locale: doc.locale,
      progress: st.progress,
      optional: st.optional.map((o) => publicQuestion(o)),
      missing: st.remaining.map((q) => ({ questionId: q.id, text: localize(q.text, doc.locale) })),
      disclosures: disclosures(doc, answers),
    };
    if (st.blocks.length) step.blocked = st.blocks;
    if (errors?.length) step.errors = errors;
    const open = sugg.filter((s) => st.visible.some((v) => v.id === s.questionId) && !answers[s.questionId]);
    if (open.length) step.suggestions = open;
    return { step, state: st };
  }

  function mergeSuggestions(doc, fresh, answeredIds = []) {
    const kept = (doc.suggestions ?? []).filter((s) => !answeredIds.includes(s.questionId) && !fresh.some((f) => f.questionId === s.questionId));
    const all = [...kept, ...fresh];
    if (all.length) doc.suggestions = all; else delete doc.suggestions;
  }

  // ------------------------------------------------------------ service functions

  /** Start a session and return the first step. */
  async function startSession({ lob, lossType, channel, locale, policyNumber, actor = SYSTEM_ACTOR } = {}) {
    const c = cfg();
    channel = CHANNEL_ALIASES[channel] ?? channel;
    if (!lob || !channel) throw err('bad_request', 'lob and channel are required', 400);
    const lobCfg = (c.lobs ?? []).find((l) => l.id === lob);
    if (c.lobs?.length && (!lobCfg || lobCfg.enabled === false)) throw err('unsupported_lob', `Line of business "${lob}" is not available`, 422);
    if (lobCfg?.channels?.length && !lobCfg.channels.includes(channel)) throw err('unsupported_channel', `Channel "${channel}" is not enabled for ${lob}`, 422);
    let set;
    try { set = mod('config').getQuestionSet({ lob, lossType, channel }); } catch (e) {
      if (e.status === 404) throw err('no_question_set', `No question set for ${lob}`, 422);
      throw e;
    }
    const loc = locale && (c.locales ?? ['en']).includes(locale) ? locale : 'en';
    const id = ctx.db.id('isn');
    const now = nowIso();
    const doc = {
      id, tenantId: ctx.tenant.id, lob, channel, locale: loc, questionSetId: set.id, questionSetVersion: set.version,
      startedBy: { type: actor.type ?? 'user', ...(actor.id ? { id: actor.id } : {}), ...(actor.role ? { role: actor.role } : {}) },
      startedAt: now,
    };
    if (lossType) doc.lossType = lossType;
    if (policyNumber) doc.policyNumber = policyNumber;
    const expiresAt = newExpiry();
    ctx.db.insert('intake_sessions', {
      id, status: 'active', lob, channel, question_set_id: set.id, question_set_version: set.version,
      doc: ctx.db.toJson(doc), started_at: now, updated_at: now, expires_at: expiresAt,
    });
    audit(actor, 'intake.session.started', id, { lob, channel, questionSetId: set.id, questionSetVersion: set.version });
    ctx.log.info('intake session started', { sessionId: id, lob, channel });
    const full = { ...doc, status: 'active', expiresAt, updatedAt: now };
    const { step, state } = await buildStep(id, full, set, {});
    if (state.next) { full.currentQuestionId = state.next.id; saveDoc(id, full); }
    return step;
  }

  /** The IntakeSession domain object (decrypted answers). */
  async function getSession(sessionId, { actor } = {}) {
    const { doc, set, answers } = await load(sessionId, actor);
    const out = { ...doc, answers };
    delete out.suggestions;
    out.progress = set ? (await evaluateState(doc, set, answers)).progress : { answered: Object.keys(answers).length, requiredRemaining: 0, percent: 0 };
    return out;
  }

  /** Next step after evaluating showIf / requiredIf. */
  async function nextQuestion(sessionId, { actor } = {}) {
    const { doc, set, answers } = await load(sessionId, actor);
    requireActive(doc);
    return (await buildStep(sessionId, doc, set, answers)).step;
  }

  /**
   * Record answers. Invalid ones are reported in `errors[]` and not stored; valid ones in the same call are kept.
   * An item may carry provenance 'ai_extraction' to confirm a pending suggestion.
   */
  async function answer(sessionId, items, { actor = SYSTEM_ACTOR } = {}) {
    if (!Array.isArray(items) || !items.length || items.length > MAX_BATCH) throw err('bad_request', `answers must be a non-empty array (max ${MAX_BATCH})`, 400);
    const { doc, set, answers } = await load(sessionId, actor);
    requireActive(doc);
    const today = nowIso().slice(0, 10);
    const errors = [];
    const accepted = [];
    const sizes = new Map(Object.entries(answers).map(([k, v]) => [k, answerBytes(v?.value)]));
    let total = [...sizes.values()].reduce((a, b) => a + b, 0);
    const source = actor.role === 'csr' ? 'csr' : actor.type === 'integration' ? 'api' : 'user';
    for (const it of items) {
      const q = set.questions.find((x) => x.id === it?.questionId);
      if (!q) { errors.push({ questionId: String(it?.questionId ?? ''), message: 'Unknown question.' }); continue; }
      const { visible } = applicable(set, buildFacts(doc, answers), evalCond);
      if (!visible.some((v) => v.id === q.id)) { errors.push({ questionId: q.id, message: localize({ en: 'This question does not apply.', es: 'Esta pregunta no aplica.' }, doc.locale) }); continue; }
      let value = it.value;
      if ((q.type === 'number' || q.type === 'currency') && typeof value === 'string' && value.trim() !== '') value = Number(value);
      total += answerBytes(value) - (sizes.get(q.id) ?? 0);
      sizes.set(q.id, answerBytes(value));
      const tooBig = checkAnswerSize(value, total);
      if (tooBig) throw err('answer_too_large', tooBig, 400);
      const message = validateAnswer(q, value, { locale: doc.locale, today });
      if (message) { errors.push({ questionId: q.id, message }); continue; }
      const rec = { value, answeredAt: nowIso(), provenance: { source } };
      const pending = (doc.suggestions ?? []).find((s) => s.questionId === q.id);
      if (it.provenance === 'ai_extraction' && pending && JSON.stringify(pending.value) === JSON.stringify(value)) {
        rec.provenance = { source: 'ai_extraction', confirmedBy: actor.id ?? 'anonymous', confirmedAt: rec.answeredAt };
        rec.confidence = pending.ai.confidence;
      }
      answers[q.id] = rec;
      accepted.push({ q, rec });
    }
    ctx.db.transaction(() => {
      for (const { q, rec } of accepted) {
        ctx.db.run('DELETE FROM intake_answers WHERE session_id = ? AND question_id = ?', sessionId, q.id);
        ctx.db.insert('intake_answers', {
          session_id: sessionId, question_id: q.id, value_enc: ctx.crypto.encryptPii(JSON.stringify(rec.value)),
          provenance: ctx.db.toJson({ provenance: rec.provenance, confidence: rec.confidence }), answered_at: rec.answeredAt,
        });
      }
    });
    mergeSuggestions(doc, [], accepted.map((a) => a.q.id));
    // Conversational mode: a free-text answer to an aiAssist question can prefill other open questions.
    for (const { q, rec } of accepted) {
      if (q.aiAssist && (q.type === 'longtext' || q.type === 'text') && typeof rec.value === 'string' && rec.value.length >= 20) {
        const { visible } = applicable(set, buildFacts(doc, answers), evalCond);
        mergeSuggestions(doc, await suggestFromNarrative(ctx, rec.value, { questions: visible, answers, locale: doc.locale, skipQuestionId: q.id }));
      }
    }
    if (accepted.length) {
      doc.updatedAt = nowIso();
      doc.expiresAt = newExpiry();
      audit(actor, 'intake.answers.recorded', sessionId, { questionIds: accepted.map((a) => a.q.id) });
    }
    const built = await buildStep(sessionId, doc, set, answers, { errors });
    doc.currentQuestionId = built.state.next?.id;
    if (doc.currentQuestionId === undefined) delete doc.currentQuestionId;
    if (accepted.length) saveDoc(sessionId, doc);
    return built.step;
  }

  /** Conversational entry: free text in, suggested answers out (confirm via answer() with provenance 'ai_extraction'). */
  async function narrative(sessionId, text, { actor = SYSTEM_ACTOR } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw err('bad_request', 'text must be 1-8000 characters', 400);
    const { doc, set, answers } = await load(sessionId, actor);
    requireActive(doc);
    const { visible } = applicable(set, buildFacts(doc, answers), evalCond);
    mergeSuggestions(doc, await suggestFromNarrative(ctx, text, { questions: visible, answers, locale: doc.locale }));
    doc.updatedAt = nowIso();
    saveDoc(sessionId, doc);
    return (await buildStep(sessionId, doc, set, answers)).step;
  }

  // Claimants and agents only learn the claim handle; triage/fraud/routing/PII stay out (SEC2-004).
  const submitView = (actor, c) => (['claimant', 'agent'].includes(actor?.role) ? { id: c.id, claimNumber: c.claimNumber, status: c.status } : c);

  /** Optional S4-WFL-01 hook: mapping.enrichClaimCreate adds policy snapshot data. Never blocks submit. */
  async function enrich(input, doc, answers, questions) {
    if (typeof mapping.enrichClaimCreate !== 'function') return input;
    const getSnapshot = async (policyNumber, asOf) => {
      try {
        return await mod('coverage')?.getPolicySnapshot?.({ policyNumber, asOf: asOf ?? input.lossEvent?.lossDate ?? nowIso().slice(0, 10) }) ?? null;
      } catch { return null; }
    };
    try {
      const out = await mapping.enrichClaimCreate(input, { session: doc, answers, questions, getSnapshot });
      return out && typeof out === 'object' ? out : input;
    } catch (e) {
      ctx.log.warn('intake enrichment failed, submitting unenriched', { sessionId: doc.id, error: e?.code ?? e?.name });
      return input;
    }
  }

  /** Submit a complete session: map to ClaimCreate and call claims.createClaim. Idempotent. */
  async function submit(sessionId, { actor = SYSTEM_ACTOR, idempotencyKey } = {}) {
    const { doc, set, answers } = await load(sessionId, actor);
    if (doc.status === 'submitted' && doc.claimId) return submitView(actor, await mod('claims').getClaim(doc.claimId));
    requireActive(doc);
    const st = await evaluateState(doc, set, answers);
    if (st.remaining.length) throw err('session_incomplete', `Required questions unanswered: ${st.remaining.map((q) => q.id).join(', ')}`, 422);
    if (st.blocks.length) throw err('submit_blocked', `Submission blocked by rule: ${st.blocks.join('; ')}`, 422);
    const lobCfg = (cfg().lobs ?? []).find((l) => l.id === doc.lob);
    const { input, missing } = toClaimCreate(doc, answers, st.visible, lobCfg);
    if (missing.length) throw err('session_incomplete', `Cannot create a claim without: ${missing.join(', ')}`, 422);
    const key = namespacedKey(sessionId, idempotencyKey, (m) => err('bad_request', m, 400));
    const enriched = await enrich(input, doc, answers, st.visible);
    const claim = await mod('claims').createClaim(enriched, { actor, idempotencyKey: key });
    const now = nowIso();
    doc.status = 'submitted';
    doc.claimId = claim.id;
    doc.submittedAt = now;
    doc.updatedAt = now;
    delete doc.suggestions;
    delete doc.currentQuestionId;
    saveDoc(sessionId, doc);
    audit(actor, 'intake.session.submitted', sessionId, { claimId: claim.id });
    ctx.log.info('intake session submitted', { sessionId, claimId: claim.id });
    return submitView(actor, claim);
  }

  /** Expire active sessions whose question set no longer exists (tenant.config.updated). Returns count. */
  function expireOrphaned() {
    const ids = new Set((cfg().questionSets ?? []).map((s) => s.id));
    const now = nowIso();
    let n = 0;
    for (const row of ctx.db.all("SELECT id, status, question_set_id, expires_at, doc FROM intake_sessions WHERE status IN ('active', 'expired')")) {
      const orphaned = row.status === 'active' && (!ids.has(row.question_set_id) || (row.expires_at && row.expires_at < now));
      const stale = row.status === 'expired' && String(row.doc).includes('"suggestionsEnc"');
      if (!orphaned && !stale) continue;
      const { suggestionsEnc, suggestions, ...doc } = ctx.db.parseJson(row.doc, {}); // eslint-disable-line no-unused-vars
      ctx.db.update('intake_sessions', row.id, { status: 'expired', doc: ctx.db.toJson(doc), updated_at: now });
      if (orphaned) n += 1;
    }
    return n;
  }

  return { startSession, getSession, nextQuestion, answer, narrative, submit, expireOrphaned };
}
