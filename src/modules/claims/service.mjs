import { createPii } from './pii.mjs';
import { checkTransition, TERMINAL } from './lifecycle.mjs';
import { createTimers } from './timers.mjs';

const CHANNELS = ['claimant_web', 'claimant_mobile', 'csr_phone', 'agent_portal', 'api', 'email', 'partner'];
const TASK_TYPES = ['contact_insured', 'contact_claimant', 'request_document', 'inspect', 'review_coverage', 'siu_referral', 'subrogation_review', 'review_ai_output', 'other'];
const TASK_STATUS = ['open', 'in_progress', 'done', 'cancelled'];
const TASK_PRIORITY = ['low', 'normal', 'high', 'urgent'];
const NOTE_CATEGORIES = ['general', 'contact', 'coverage', 'liability', 'fraud', 'subrogation', 'ai_summary', 'system'];
const VISIBILITY = ['internal', 'shared_with_claimant'];
const COVERAGE_CHECKS = ['pending', 'covered', 'partial', 'not_covered', 'policy_not_found', 'needs_review'];
const REF_STATUS = ['pending', 'synced', 'failed'];
const SYSTEM = { type: 'system', id: 'claims', role: 'system' };

/** Strip internal fields so an actor matches common.schema.json#/$defs/Actor. */
const publicActor = (a) => ({ type: a.type, ...(a.id ? { id: a.id } : {}), ...(a.role ? { role: a.role } : {}) });
const label = (a) => `${a.type}:${a.id ?? 'unknown'}`;

/** Accepts an Actor object, a bare user id string (as other modules pass), or nothing (system). */
function normalizeActor(a) {
  if (!a) return { ...SYSTEM };
  if (typeof a === 'string') return { type: 'user', id: a };
  return { ...a, type: a.type ?? 'user' };
}

const bad = (ctx, message, code = 'validation_failed') => new ctx.AppError(code, message, 422);

/**
 * Claims service, bound to one tenant (modules.md rule 3). Public functions are async; each mutation runs in
 * one synchronous transaction that writes the row, an audit entry and the outbox event together.
 * @param {object} ctx tenant-bound ctx
 */
export function createService(ctx) {
  if (!ctx.tenant) {
    // Boot-time root instance: tenant data must go through ctx.forTenant(id).modules.claims.
    const refuse = async () => { throw new ctx.AppError('tenant_required', 'Use a tenant-bound ctx (ctx.forTenant) for claims', 500); };
    return new Proxy({}, { get: (_t, name) => (typeof name === 'string' && name !== 'then' ? refuse : undefined) });
  }
  const db = ctx.db;
  const pii = createPii(ctx);
  const tenantId = ctx.tenant.id;
  const notFound = (what = 'Claim') => new ctx.AppError('not_found', `${what} not found`, 404);

  // ---- persistence helpers -------------------------------------------------------------------------
  const rowOf = (claimId) => db.get('SELECT * FROM claims WHERE id = ?', claimId);

  /** Stored claim (doc, with the lossEvent still encrypted). */
  function load(claimId) {
    const r = rowOf(claimId);
    if (!r) throw notFound();
    const doc = JSON.parse(r.doc);
    return { ...doc, status: r.status, version: r.version, updatedAt: r.updated_at };
  }
  const tryLoad = (claimId) => { try { return load(claimId); } catch { return null; } };

  function columns(claim) {
    return {
      status: claim.status, lob: claim.lob, channel: claim.channel, policy_number: claim.policyNumber ?? null,
      risk_state: claim.riskState ?? null, severity: claim.triage?.severityScore ?? null,
      queue: claim.routing?.queue ?? null, adjuster_id: claim.routing?.adjusterId ?? null,
      fast_track: claim.routing?.fastTrack || claim.status === 'fast_tracked' ? 1 : 0,
      version: claim.version, updated_at: claim.updatedAt, doc: claim,
    };
  }

  /** Persist a modified claim: bumps version and updatedAt, optionally enforcing expectedVersion. */
  function save(claim, expectedVersion) {
    const current = rowOf(claim.id);
    if (expectedVersion != null && Number(expectedVersion) !== current.version) {
      throw new ctx.AppError('version_conflict', `Claim is at version ${current.version}, not ${expectedVersion}`, 409);
    }
    claim.version = current.version + 1;
    claim.updatedAt = ctx.clock.nowIso();
    db.update('claims', claim.id, columns(claim));
    return claim;
  }

  /** Insertion order within a claim (rowid is not available through the tenant-scoped store). */
  const nextSeq = (table, claimId) => db.get(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM ${table} WHERE claim_id = ?`, claimId).n;

  const children = (table, claimId) => db.all(`SELECT doc FROM ${table} WHERE claim_id = ? ORDER BY seq`, claimId).map((r) => JSON.parse(r.doc));

  /** Domain Claim from a stored one. opts: include[], redact (replace x-pii values with [redacted]). */
  function present(claim, { include = [], redact = false } = {}) {
    const p = redact ? pii.redact : pii.decrypt;
    const out = { ...claim, lossEvent: p(claim.lossEvent, 'lossEvent') };
    if (include.includes('parties')) out.parties = children('claim_parties', claim.id).map((x) => p(x, 'party'));
    if (include.includes('vehicles')) out.vehicles = children('claim_vehicles', claim.id).map((x) => p(x, 'vehicle'));
    if (include.includes('properties')) out.properties = children('claim_properties', claim.id).map((x) => p(x, 'property'));
    return out;
  }

  const audit = (actor, action, claimId, details = {}) =>
    ctx.audit.record({ actor: label(actor), action, entityType: 'claim', entityId: claimId, details });

  /** claim.updated: additive event for mutations the contract has no dedicated event for (see result notes). */
  function touch(claimId, change, extra = {}) {
    const version = rowOf(claimId)?.version;
    ctx.bus.publish('claim.updated', claimId, { claimId, change, version, ...extra });
  }

  // ---- timers --------------------------------------------------------------------------------------
  const timers = createTimers(ctx, {
    loadClaim: tryLoad,
    touch,
    addFlag: (id, flag, actor) => addFlagSync(id, flag, { actor }),
    addTask: (id, input, actor) => addTaskSync(id, input, { actor }),
    setQueue: (id, patch, actor) => setQueueSync(id, patch, actor),
  });

  // ---- claim creation ------------------------------------------------------------------------------
  function allocateNumber(now) {
    const year = now.getUTCFullYear();
    const row = db.get('SELECT next FROM claim_number_seq WHERE year = ?', year);
    if (row) db.run('UPDATE claim_number_seq SET next = next + 1 WHERE year = ?', year);
    else db.insert('claim_number_seq', { year, next: 2 });
    const n = row ? row.next : 1;
    const prefix = ctx.tenant.config?.claimNumberPrefix ?? tenantId.replace(/[^a-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X');
    return `${prefix}-${year}-${String(n).padStart(6, '0')}`;
  }

  function createClaimSync(input, { actor, idempotencyKey } = {}) {
    actor = normalizeActor(actor);
    if (!input || typeof input !== 'object') throw bad(ctx, 'Claim body is required');
    if (input.tenantId && input.tenantId !== tenantId) throw new ctx.AppError('tenant_mismatch', 'tenantId does not match the token tenant', 403);
    const { lossEvent } = input;
    if (typeof input.lob !== 'string' || !input.lob) throw bad(ctx, 'lob is required');
    if (!lossEvent || !lossEvent.lossDate || !lossEvent.cause || typeof lossEvent.description !== 'string') {
      throw bad(ctx, 'lossEvent.lossDate, lossEvent.cause and lossEvent.description are required');
    }
    const channel = input.channel ?? 'api';
    if (!CHANNELS.includes(channel)) throw bad(ctx, `channel must be one of ${CHANNELS.join(', ')}`);
    for (const p of input.parties ?? []) {
      if (!Array.isArray(p.roles) || !p.roles.length || !p.kind) throw bad(ctx, 'each party needs roles[] and kind');
    }

    return db.transaction(() => {
      if (idempotencyKey) {
        const prior = db.get('SELECT id FROM claims WHERE idempotency_key = ?', idempotencyKey);
        if (prior) return present(load(prior.id), { include: ['parties', 'vehicles', 'properties'] });
      }
      const now = ctx.clock.now();
      const nowIso = now.toISOString();
      const id = db.id('clm');
      const strip = (e, kind) => {
        const { id: _i, tenantId: _t, claimId: _c, ...rest } = e;
        return pii.encrypt({ ...rest, id: db.id(kind), tenantId, claimId: id }, { pty: 'party', veh: 'vehicle', prp: 'property' }[kind]);
      };
      const parties = (input.parties ?? []).map((p) => strip(p, 'pty'));
      const vehicles = (input.vehicles ?? []).map((v) => strip(v, 'veh'));
      const properties = (input.properties ?? []).map((p) => strip(p, 'prp'));
      const riskState = input.riskState ?? lossEvent.location?.state ?? lossEvent.location?.address?.state
        ?? (input.properties ?? []).find((p) => p.address?.state)?.address.state ?? undefined;
      const claim = {
        id, tenantId, claimNumber: allocateNumber(now), status: 'reported', lob: input.lob,
        ...(input.lossType ? { lossType: input.lossType } : {}), channel,
        ...(input.policyNumber ? { policyNumber: input.policyNumber } : {}), ...(riskState ? { riskState } : {}),
        lossEvent: pii.encrypt(lossEvent, 'lossEvent'), documentIds: [],
        ...(input.intakeSessionId ? { intakeSessionId: input.intakeSessionId } : {}),
        checks: { coverage: 'pending', evidence: 'none' }, flags: [], externalRefs: [],
        reportedAt: nowIso, reportedBy: publicActor(actor), version: 1, createdAt: nowIso, updatedAt: nowIso,
      };
      if (input.externalRef?.system && input.externalRef?.id) {
        claim.externalRefs.push({ system: input.externalRef.system, id: input.externalRef.id, status: 'pending' });
      }
      db.insert('claims', {
        id, claim_number: claim.claimNumber, ...columns(claim), reported_at: nowIso, idempotency_key: idempotencyKey ?? null,
      });
      parties.forEach((p, i) => db.insert('claim_parties', { id: p.id, claim_id: id, seq: i + 1, doc: p }));
      vehicles.forEach((v, i) => db.insert('claim_vehicles', { id: v.id, claim_id: id, seq: i + 1, doc: v }));
      properties.forEach((p, i) => db.insert('claim_properties', { id: p.id, claim_id: id, seq: i + 1, doc: p }));
      db.insert('claim_status_history', {
        id: db.id('sth'), claim_id: id, seq: 1, from_status: null, to_status: 'reported', version: 1, actor: label(actor), reason: null, at: nowIso,
      });
      audit(actor, 'claim.created', id, {
        claimNumber: claim.claimNumber, lob: claim.lob, channel, parties: parties.length, vehicles: vehicles.length, properties: properties.length,
      });
      ctx.bus.publish('claim.reported', id, {
        claimId: id, claimNumber: claim.claimNumber, lob: claim.lob, ...(claim.lossType ? { lossType: claim.lossType } : {}), channel,
        ...(claim.policyNumber ? { policyNumber: claim.policyNumber } : {}), lossDate: lossEvent.lossDate, lossCause: lossEvent.cause,
        ...(riskState ? { riskState } : {}),
        ...(typeof lossEvent.injuriesReported === 'boolean' ? { injuriesReported: lossEvent.injuriesReported } : {}),
        ...(Number.isInteger(lossEvent.vehiclesInvolved) ? { vehiclesInvolved: lossEvent.vehiclesInvolved } : {}),
        documentCount: 0, ...(claim.intakeSessionId ? { intakeSessionId: claim.intakeSessionId } : {}), reportedAt: nowIso,
      });
      timers.start(claim, 'claim.reported', now, { quiet: true });
      return present(claim, { include: ['parties', 'vehicles', 'properties'] });
    });
  }

  // ---- reads ---------------------------------------------------------------------------------------
  function getClaimSync(claimId, { include = [], redact = false } = {}) {
    return present(load(claimId), { include, redact });
  }

  function getClaimBundleSync(claimId) {
    const claim = present(load(claimId));
    return {
      claim,
      parties: children('claim_parties', claimId).map((x) => pii.decrypt(x, 'party')),
      vehicles: children('claim_vehicles', claimId).map((x) => pii.decrypt(x, 'vehicle')),
      properties: children('claim_properties', claimId).map((x) => pii.decrypt(x, 'property')),
    };
  }

  /** Non-staff scope: the caller reported the claim, or the claim is on one of the given policies. */
  const visibleTo = (claim, { reportedById, policyNumbers = [] }) =>
    (reportedById !== undefined && claim.reportedBy?.id === reportedById) || (claim.policyNumber && policyNumbers.includes(claim.policyNumber));

  function listClaimsSync(filter = {}, { limit = 50, cursor } = {}) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const where = [];
    const p = [];
    const statuses = [].concat(filter.status ?? []).flatMap((s) => String(s).split(',')).filter(Boolean);
    if (statuses.length) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); p.push(...statuses); }
    const eq = (col, v) => { if (v !== undefined && v !== '') { where.push(`${col} = ?`); p.push(v); } };
    eq('lob', filter.lob); eq('queue', filter.queue); eq('adjuster_id', filter.adjusterId); eq('risk_state', filter.riskState);
    if (filter.fastTrack !== undefined) { where.push('fast_track = ?'); p.push(filter.fastTrack === true || filter.fastTrack === 'true' ? 1 : 0); }
    if (filter.severityMin !== undefined) { where.push('severity >= ?'); p.push(Number(filter.severityMin)); }
    if (filter.reportedFrom) { where.push('reported_at >= ?'); p.push(new Date(filter.reportedFrom).toISOString()); }
    if (filter.reportedTo) { where.push('reported_at <= ?'); p.push(new Date(filter.reportedTo).toISOString()); }
    if (filter.q) {
      const q = String(filter.q).replace(/[\\%_]/g, (c) => `\\${c}`);
      where.push("(claim_number LIKE ? ESCAPE '\\' OR policy_number LIKE ? ESCAPE '\\')");
      p.push(`${q}%`, `${q}%`);
    }
    if (filter.flag) { where.push("doc LIKE ? ESCAPE '\\'"); p.push(`%"${String(filter.flag).replace(/[\\%_"]/g, '')}"%`); }
    const order = {
      reportedAt: 'reported_at ASC, id ASC', '-reportedAt': 'reported_at DESC, id DESC',
      severity: 'COALESCE(severity, -1) ASC, id ASC', '-severity': 'COALESCE(severity, -1) DESC, id DESC',
    }[filter.sort ?? '-reportedAt'] ?? 'reported_at DESC, id DESC';
    let offset = 0;
    if (cursor) {
      try { offset = JSON.parse(Buffer.from(String(cursor), 'base64url').toString()).o; } catch { throw new ctx.AppError('bad_cursor', 'Invalid cursor', 400); }
      if (!Number.isInteger(offset) || offset < 0) throw new ctx.AppError('bad_cursor', 'Invalid cursor', 400);
    }
    const items = [];
    let scanned = offset;
    let more = false;
    // Scan in batches so the post-filter on flags (the LIKE above is only a prefilter) still fills the page.
    while (items.length <= limit) {
      const rows = db.all(`SELECT * FROM claims ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ? OFFSET ?`, ...p, limit + 1, scanned);
      for (const r of rows) {
        scanned++;
        const claim = { ...JSON.parse(r.doc), status: r.status, version: r.version, updatedAt: r.updated_at };
        if (filter.flag && !claim.flags?.includes(filter.flag)) continue;
        if (filter.reportedById !== undefined && claim.reportedBy?.id !== filter.reportedById) continue;
        if (filter.visibleTo && !visibleTo(claim, filter.visibleTo)) continue;
        if (items.length === limit) { more = true; scanned--; break; }
        items.push(claim);
      }
      if (more || rows.length < limit + 1) break;
    }
    return {
      items: items.map((c) => present(c, { redact: filter.redact === true })),
      nextCursor: more ? Buffer.from(JSON.stringify({ o: scanned })).toString('base64url') : null,
    };
  }

  // ---- lifecycle -----------------------------------------------------------------------------------
  function transition(claim, to, { actor, reason, closeReason }) {
    const from = claim.status;
    const err = checkTransition(from, to, actor, { closeReason });
    if (err) throw new ctx.AppError(err.code, err.message, err.status);
    claim.status = to;
    if (to === 'closed') { claim.closedAt = ctx.clock.nowIso(); claim.closeReason = closeReason; }
    if (from === 'closed') { delete claim.closedAt; delete claim.closeReason; }
    return from;
  }

  /**
   * History keeps the free-text reason encrypted (with its code); the event and audit carry only the
   * machine-readable reasonCode, never free text.
   */
  function recordStatus(claim, from, actor, reason, extra = {}, reasonCode) {
    const sealed = reason || reasonCode ? ctx.crypto.encryptPii(JSON.stringify({ v: { code: reasonCode ?? null, text: reason ?? null } })) : null;
    db.insert('claim_status_history', {
      id: db.id('sth'), claim_id: claim.id, seq: nextSeq('claim_status_history', claim.id), from_status: from, to_status: claim.status, version: claim.version,
      actor: label(actor), reason: sealed, at: claim.updatedAt,
    });
    audit(actor, 'claim.status.changed', claim.id, { from, to: claim.status, version: claim.version, ...(reasonCode ? { reasonCode } : {}), ...extra });
    ctx.bus.publish('claim.status.changed', claim.id, {
      claimId: claim.id, from, to: claim.status, ...(reasonCode ? { reasonCode } : {}), version: claim.version, actor: publicActor(actor),
    });
  }

  /** Status history, oldest first. Reasons are decrypted only when requested (staff PII roles). */
  function listStatusHistorySync(claimId, { decrypt = false } = {}) {
    load(claimId);
    return db.all('SELECT * FROM claim_status_history WHERE claim_id = ? ORDER BY seq', claimId).map((r) => {
      let reasonCode = null;
      let reason = null;
      if (r.reason) {
        try { const v = JSON.parse(ctx.crypto.decryptPii(r.reason)).v; reasonCode = v.code ?? null; if (decrypt) reason = v.text ?? null; } catch { /* legacy plain text is never returned */ }
      }
      return { seq: r.seq, from: r.from_status, to: r.to_status, version: r.version, actor: r.actor, at: r.at, reasonCode, ...(decrypt ? { reason } : {}) };
    });
  }

  function changeStatusSync(claimId, { to, reason, reasonCode, closeReason, expectedVersion, actor } = {}) {
    actor = normalizeActor(actor);
    if (reasonCode != null && !(typeof reasonCode === 'string' && /^[a-z][a-z0-9_]{1,39}$/.test(reasonCode))) {
      throw bad(ctx, 'reasonCode must be a lowercase token such as awaiting_documents');
    }
    if (reason != null && String(reason).length > 500) throw bad(ctx, 'reason is limited to 500 characters');
    return db.transaction(() => {
      const claim = load(claimId);
      if (expectedVersion != null && Number(expectedVersion) !== claim.version) {
        throw new ctx.AppError('version_conflict', `Claim is at version ${claim.version}, not ${expectedVersion}`, 409);
      }
      const from = transition(claim, to, { actor, reason, closeReason });
      save(claim);
      recordStatus(claim, from, actor, reason, closeReason ? { closeReason } : {}, reasonCode);
      return present(claim);
    });
  }

  // ---- small claim mutations -----------------------------------------------------------------------
  function addFlagSync(claimId, flag, { actor } = {}) {
    actor = normalizeActor(actor);
    if (typeof flag !== 'string' || !/^[a-z][a-z0-9_]{1,39}$/.test(flag)) throw bad(ctx, 'flag must be a lowercase token such as injury or ack_breach');
    return db.transaction(() => {
      const claim = load(claimId);
      if (claim.flags.includes(flag)) return present(claim);
      claim.flags = [...claim.flags, flag];
      save(claim);
      audit(actor, 'claim.flag.added', claimId, { flag, version: claim.version });
      touch(claimId, 'flag_added', { flag });
      return present(claim);
    });
  }

  function setQueueSync(claimId, patch, actor) {
    return db.transaction(() => {
      const claim = load(claimId);
      claim.routing = { ...(claim.routing ?? {}), ...patch };
      save(claim);
      audit(actor, 'claim.routing.updated', claimId, { ...patch, version: claim.version });
      touch(claimId, 'routing_updated', patch);
      return present(claim);
    });
  }

  function setExternalRefSync(claimId, ref, { actor } = {}) {
    actor = normalizeActor(actor);
    if (!ref?.system || !ref?.id) throw bad(ctx, 'system and id are required');
    if (ref.status && !REF_STATUS.includes(ref.status)) throw bad(ctx, `status must be one of ${REF_STATUS.join(', ')}`);
    return db.transaction(() => {
      const claim = load(claimId);
      const entry = { system: ref.system, id: ref.id, status: ref.status ?? 'pending', ...(ref.status === 'synced' ? { syncedAt: ctx.clock.nowIso() } : {}) };
      claim.externalRefs = [...claim.externalRefs.filter((r) => r.system !== ref.system), entry];
      save(claim);
      audit(actor, 'claim.external_ref.set', claimId, { system: ref.system, status: entry.status, version: claim.version });
      touch(claimId, 'external_ref_set', { system: ref.system, status: entry.status });
      return present(claim);
    });
  }

  // ---- notes ---------------------------------------------------------------------------------------
  function addNoteSync(claimId, { body, category = 'general', visibility = 'internal', ai } = {}, { actor } = {}) {
    actor = normalizeActor(actor);
    if (typeof body !== 'string' || !body.trim()) throw bad(ctx, 'body is required');
    if (body.length > 20000) throw bad(ctx, 'body is limited to 20000 characters');
    if (!NOTE_CATEGORIES.includes(category)) throw bad(ctx, `category must be one of ${NOTE_CATEGORIES.join(', ')}`);
    if (!VISIBILITY.includes(visibility)) throw bad(ctx, `visibility must be one of ${VISIBILITY.join(', ')}`);
    return db.transaction(() => {
      load(claimId);
      const note = {
        id: db.id('nte'), tenantId, claimId, body, category, visibility, author: publicActor(actor), ...(ai ? { ai } : {}), createdAt: ctx.clock.nowIso(),
      };
      db.insert('claim_notes', { id: note.id, claim_id: claimId, seq: nextSeq('claim_notes', claimId), doc: pii.encrypt(note, 'note'), created_at: note.createdAt });
      audit(actor, 'claim.note.added', claimId, { noteId: note.id, category, visibility });
      ctx.bus.publish('claim.note.added', claimId, {
        claimId, noteId: note.id, category, visibility, author: note.author, ...(ai ? { aiGenerated: true } : {}),
      });
      return note;
    });
  }

  function listNotesSync(claimId, { redact = false } = {}) {
    load(claimId);
    const p = redact ? pii.redact : pii.decrypt;
    return db.all('SELECT doc FROM claim_notes WHERE claim_id = ? ORDER BY seq DESC', claimId).map((r) => p(JSON.parse(r.doc), 'note'));
  }

  // ---- tasks ---------------------------------------------------------------------------------------
  const taskOut = (doc) => { const { requestedType: _r, ...t } = doc; return t; };

  function addTaskSync(claimId, input = {}, { actor, sourceRuleId } = {}) {
    actor = normalizeActor(actor);
    if (typeof input.title !== 'string' || !input.title.trim()) throw bad(ctx, 'title is required');
    if (input.priority && !TASK_PRIORITY.includes(input.priority)) throw bad(ctx, `priority must be one of ${TASK_PRIORITY.join(', ')}`);
    return db.transaction(() => {
      load(claimId);
      const requested = input.type ?? 'other';
      // Tenant rules may use task types outside the domain enum; the enum value is "other" and the
      // requested type is kept so timer stopOn.taskType can still match it.
      const type = TASK_TYPES.includes(requested) ? requested : 'other';
      const task = {
        id: db.id('tsk'), tenantId, claimId, type, title: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}), ...(input.queue ? { queue: input.queue } : {}),
        priority: input.priority ?? 'normal', status: 'open', ...(input.dueAt ? { dueAt: input.dueAt } : {}),
        createdBy: publicActor(actor), ...((sourceRuleId ?? input.sourceRuleId) ? { sourceRuleId: sourceRuleId ?? input.sourceRuleId } : {}),
        ...(input.timerId ? { timerId: input.timerId } : {}), createdAt: ctx.clock.nowIso(),
        ...(requested !== type ? { requestedType: requested } : {}),
      };
      db.insert('claim_tasks', { id: task.id, claim_id: claimId, seq: nextSeq('claim_tasks', claimId), type, status: task.status, doc: task, created_at: task.createdAt });
      audit(actor, 'claim.task.added', claimId, { taskId: task.id, type: requested, sourceRuleId: task.sourceRuleId });
      touch(claimId, 'task_added', { taskId: task.id });
      return taskOut(task);
    });
  }

  function updateTaskSync(claimId, taskId, patch = {}, { actor } = {}) {
    actor = normalizeActor(actor);
    if (patch.status && !TASK_STATUS.includes(patch.status)) throw bad(ctx, `status must be one of ${TASK_STATUS.join(', ')}`);
    return db.transaction(() => {
      load(claimId);
      const r = db.get('SELECT * FROM claim_tasks WHERE id = ? AND claim_id = ?', taskId, claimId);
      if (!r) throw notFound('Task');
      const task = JSON.parse(r.doc);
      const wasDone = task.status === 'done';
      for (const k of ['status', 'assigneeId', 'priority', 'dueAt', 'title', 'description']) if (patch[k] !== undefined) task[k] = patch[k];
      if (task.status === 'done' && !wasDone) task.completedAt = ctx.clock.nowIso();
      db.update('claim_tasks', taskId, { status: task.status, doc: task });
      audit(actor, 'claim.task.updated', claimId, { taskId, status: task.status });
      touch(claimId, 'task_updated', { taskId });
      if (task.status === 'done' && !wasDone) timers.onTaskCompleted(claimId, task.requestedType ?? task.type);
      return taskOut(task);
    });
  }

  const listTasksSync = (claimId) => {
    load(claimId);
    return db.all('SELECT doc FROM claim_tasks WHERE claim_id = ? ORDER BY seq', claimId).map((r) => taskOut(JSON.parse(r.doc)));
  };

  // ---- reserve (placeholder) -----------------------------------------------------------------------
  function suggestReserveSync(claimId, input = {}, { actor } = {}) {
    actor = normalizeActor(actor);
    return db.transaction(() => {
      const claim = load(claimId);
      const costType = input.costType ?? 'indemnity';
      if (!['indemnity', 'expense'].includes(costType)) throw bad(ctx, 'costType must be indemnity or expense');
      const amount = input.amount ?? { amount: (costType === 'expense' ? 250 : 1000) + (claim.triage?.severityScore ?? 0) * 100, currency: 'USD' };
      if (typeof amount.amount !== 'number' || amount.amount < 0) throw bad(ctx, 'amount.amount must be a non-negative number');
      const reserve = {
        id: db.id('rsv'), tenantId, claimId, ...(input.coverageCode ? { coverageCode: input.coverageCode } : {}), costType,
        amount: { amount: amount.amount, currency: amount.currency ?? 'USD' }, status: 'suggested', basis: input.basis ?? 'rule',
        ...(input.ai ? { ai: input.ai } : {}), createdAt: ctx.clock.nowIso(),
      };
      db.insert('claim_reserves', { id: reserve.id, claim_id: claimId, seq: nextSeq('claim_reserves', claimId), doc: reserve, created_at: reserve.createdAt });
      audit(actor, 'claim.reserve.suggested', claimId, { reserveId: reserve.id, costType, basis: reserve.basis });
      touch(claimId, 'reserve_suggested', { reserveId: reserve.id });
      return reserve;
    });
  }

  // ---- event reactions -----------------------------------------------------------------------------
  const addUnique = (list, v) => (list.includes(v) ? list : [...list, v]);

  /** Mutate a claim from a fact event: save, audit, publish claim.updated; optionally move status. */
  function reactTo(evt, fn) {
    const claimId = evt.data?.claimId;
    if (!claimId || !rowOf(claimId)) {
      ctx.log.warn('claim event for unknown claim ignored', { eventType: evt.type, eventId: evt.id, claimId: claimId ?? null });
      return null;
    }
    return db.transaction(() => {
      const claim = load(claimId);
      const before = JSON.stringify(claim);
      const moves = fn(claim) ?? [];
      if (JSON.stringify(claim) === before && !moves.length) return present(claim);
      const staged = [];
      let prev = claim.status;
      for (const to of moves) {
        const from = transition(claim, to, { actor: SYSTEM });
        staged.push({ from, to });
      }
      claim.status = staged.length ? staged[staged.length - 1].to : claim.status;
      save(claim);
      // One history row + status event per hop; versions equal the saved version for the final hop.
      let s = prev;
      for (const hop of staged) {
        claim.status = hop.to;
        recordStatus(claim, s, SYSTEM, `event ${evt.type}`);
        s = hop.to;
      }
      claim.status = staged.length ? staged[staged.length - 1].to : claim.status;
      audit(SYSTEM, 'claim.updated', claimId, { source: evt.type, eventId: evt.id, version: claim.version });
      touch(claimId, 'updated_from_event', { source: evt.type });
      return present(claim);
    });
  }

  function applyEvent(evt) {
    const d = evt.data ?? {};
    switch (evt.type) {
      case 'claim.reported':
        return reactTo(evt, (c) => (c.status === 'reported' ? ['validating'] : []));
      case 'claim.coverage.verified':
        return reactTo(evt, (c) => {
          if (COVERAGE_CHECKS.includes(d.outcome)) c.checks = { ...c.checks, coverage: d.outcome };
          if (d.verificationId) c.checks.coverageVerificationId = d.verificationId;
          if (d.policySnapshotId) c.policySnapshotId = d.policySnapshotId;
        });
      case 'claim.evidence.added':
        return reactTo(evt, (c) => {
          c.checks = { ...c.checks, evidence: 'pending' };
          if (d.documentId) c.documentIds = addUnique(c.documentIds ?? [], d.documentId);
        });
      case 'claim.evidence.extracted':
        return reactTo(evt, (c) => {
          if (d.documentId) c.documentIds = addUnique(c.documentIds ?? [], d.documentId);
          if (d.status === 'failed') c.checks = { ...c.checks, evidence: 'failed' };
          else if (d.status === 'completed' || d.status === 'partial') c.checks = { ...c.checks, evidence: 'extracted' };
        });
      case 'claim.triaged':
        return reactTo(evt, (c) => {
          c.triage = {
            ...(d.triageResultId ? { resultId: d.triageResultId } : {}), severityScore: d.severityScore, complexity: d.complexity,
            fraudScore: d.fraudScore, subrogation: d.subrogation,
          };
          if (c.status === 'reported') return ['validating', 'triaged'];
          return c.status === 'validating' ? ['triaged'] : [];
        });
      case 'claim.routed':
        return reactTo(evt, (c) => {
          c.routing = {
            ...(d.decisionId ? { decisionId: d.decisionId } : {}), ...(d.queue ? { queue: d.queue } : {}),
            ...(d.adjusterId ? { adjusterId: d.adjusterId } : {}), fastTrack: d.outcome === 'fast_tracked',
          };
          return c.status === 'triaged' && ['assigned', 'fast_tracked'].includes(d.outcome) ? [d.outcome] : [];
        });
      default:
        return null;
    }
  }

  /** Timer starts/stops for any event: tenant timer config names the events (startOn, stopOn). */
  function applyTimerEvent(evt) {
    if (!evt.data?.claimId) return;
    if (!rowOf(evt.data.claimId)) {
      ctx.log.warn('timer event for unknown claim ignored', { eventType: evt.type, eventId: evt.id, claimId: evt.data.claimId });
      return;
    }
    db.transaction(() => {
      if (evt.type === 'claim.status.changed') timers.onStatusChanged(evt.data.claimId, evt.data.to);
      else timers.onEvent(evt);
      timers.onStartEvent(evt);
    });
  }

  /**
   * REQ-12 instant acknowledgment (PoC: recorded, nothing is sent). On claim.reported the platform acknowledges the
   * claimant through the tenant's first configured claimant channel: an audit entry, a completed acknowledge_claimant
   * task (which meets the acknowledge timer), and a claim.acknowledged event. Idempotent per claim.
   */
  function acknowledgeClaim(claimId, { actor } = {}) {
    actor = normalizeActor(actor);
    const c = ctx.tenant.config ?? {};
    const claimantCfg = c.notifications?.claimant ?? {};
    if (!claimantCfg.channels?.length) return null; // no claimant channel configured: nothing to acknowledge through
    if (claimantCfg.onEvents && !claimantCfg.onEvents.includes('claim.reported')) return null;
    return db.transaction(() => {
      load(claimId);
      const prior = db.get("SELECT 1 AS x FROM claim_tasks WHERE claim_id = ? AND type = 'other' AND doc LIKE '%\"requestedType\":\"acknowledge_claimant\"%'", claimId);
      if (prior) return null;
      const channel = claimantCfg.channels[0];
      const at = ctx.clock.nowIso();
      const task = addTaskSync(claimId, {
        type: 'acknowledge_claimant', title: `Acknowledge claimant via ${channel}`, priority: 'normal',
        description: 'Automatic acknowledgment recorded by the platform (PoC: no message is sent).',
      }, { actor });
      audit(actor, 'claim.acknowledged', claimId, { channel, taskId: task.id, acknowledgedAt: at, delivery: 'recorded_only' });
      updateTaskSync(claimId, task.id, { status: 'done' }, { actor });
      ctx.bus.publish('claim.acknowledged', claimId, { claimId, channel, taskId: task.id, acknowledgedAt: at });
      return { claimId, channel, taskId: task.id, acknowledgedAt: at };
    });
  }

  const impl = {
    acknowledgeClaim,
    createClaim: createClaimSync, getClaim: getClaimSync, listClaims: listClaimsSync, getClaimBundle: getClaimBundleSync,
    changeStatus: changeStatusSync, listStatusHistory: listStatusHistorySync, addFlag: addFlagSync, addNote: addNoteSync, listNotes: listNotesSync,
    addTask: addTaskSync, updateTask: updateTaskSync, listTasks: listTasksSync,
    listTimers: (claimId) => { load(claimId); return timers.list(claimId); },
    suggestReserve: suggestReserveSync, setExternalRef: setExternalRefSync,
    /** Additive: apply a fact event (called by the module's subscribers). */
    applyEvent, applyTimerEvent,
    /** Additive: timer tick for this tenant. */
    sweepTimers: (now) => timers.sweep(now),
  };
  return Object.fromEntries(Object.entries(impl).map(([k, fn]) => [k, async (...a) => fn(...a)]));
}

export { TERMINAL };
