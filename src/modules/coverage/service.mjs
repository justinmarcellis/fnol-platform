// Coverage service: policy port access, verification, persistence and events.
import { resolveAdapter } from './port.mjs';
import { evaluateCoverage } from './verify.mjs';
import { lossDateInTenantZone } from './dates.mjs';

const SYSTEM_ACTOR = 'system:coverage';

const NAME_RE = /^[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F'\u2019. &-]{1,59}$/;
// Policy-number prefix in the seeded shape LL-SS-NNNNNNN: "HO", "HO-", "HO-IL", "PA-IL-", "HO-IL-10", "CA-MI-1421980".
const PREFIX_RE = /^[A-Za-z]{2,5}(?:-[A-Za-z]{1,3})?(?:-?\d*)?-?$/;
const VIN_PART_RE = /^[A-HJ-NPR-Za-hj-npr-z0-9]{6,16}$/;

/**
 * Classify a free-text search string. Order matters: VIN (17 alphanumerics), postal (5 or 9 digits),
 * phone (10 digits, or 11 with a leading 1), policy number or prefix (LL, LL-SS, LL-SS-NNN...), the last
 * 6 to 16 characters of a VIN, then a name (last name, full name or business name).
 * `alternates` are tried in order when the primary reading finds nothing (e.g. "HO" as a last name, then
 * as the HO- policy prefix; "MP394242" as a prefix, then as a VIN tail).
 * @returns {{ kind: string, criteria: object, alternates: {kind:string, criteria:object}[] }|null}
 */
export function classifyQuery(q) {
  const s = String(q ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const one = (kind, criteria, alternates = []) => ({ kind, criteria, alternates });
  const vinTail = (v) => ({ kind: 'vinSuffix', criteria: { vinSuffix: v.toUpperCase() } });
  const prefix = (v) => ({ kind: 'policyNumberPrefix', criteria: { policyNumberPrefix: v.toUpperCase() } });
  const name = (v) => ({ kind: 'lastName', criteria: { lastName: v } });
  if (/^[A-Za-z0-9]{17}$/.test(s)) return one('vin', { vin: s.toUpperCase() });
  if (/^\d{5}(-\d{4})?$/.test(s)) return one('postalCode', { postalCode: s });
  if (/^[+(\d][\d\s().+-]*$/.test(s)) {
    const d = s.replace(/\D/g, '');
    if (d.length === 10 || (d.length === 11 && d[0] === '1')) return one('phone', { phone: d.slice(-10) });
    if (/^\d{6,16}$/.test(s)) { const t = vinTail(s); return one(t.kind, t.criteria); }
    return null;
  }
  if (PREFIX_RE.test(s)) {
    const hasDash = s.includes('-');
    const hasDigit = /\d/.test(s);
    const p = prefix(s);
    if (hasDash || hasDigit) {
      const alts = [];
      if (hasDigit && !hasDash && VIN_PART_RE.test(s)) alts.push(vinTail(s));
      if (!hasDigit && NAME_RE.test(s)) alts.push(name(s)); // hyphenated surnames such as "Ray-Li"
      return one(p.kind, p.criteria, alts);
    }
    // Letters only ("HO", "Lee"): a name first, then the policy-number prefix "HO-".
    if (NAME_RE.test(s)) return one('lastName', { lastName: s }, s.length <= 3 ? [prefix(`${s}-`)] : []);
  }
  if (VIN_PART_RE.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s)) { const t = vinTail(s); return one(t.kind, t.criteria); }
  if (NAME_RE.test(s)) return one('lastName', { lastName: s });
  return null;
}

/**
 * @param {object} ctx tenant-bound context (root ctx at boot; functions need a tenant when called)
 */
export function createService(ctx) {
  const AppError = ctx.AppError;
  const adapter = () => resolveAdapter(ctx);

  async function fetchPolicy(policyNumber, asOf) {
    try {
      return await adapter().getPolicy({ policyNumber, asOf });
    } catch (e) {
      if (e?.status) throw e;
      ctx.log.error('policy port failed', { adapter: ctx.tenant?.config?.integrations?.policyPort?.adapter ?? 'mock-pas', error: e.message });
      throw new AppError('upstream_error', 'Policy system unavailable', 502);
    }
  }

  /** Per-tenant insertion order, so "latest" is stable when timestamps tie (fixed test clock). */
  const nextSeq = (table) => ctx.db.get(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM ${table}`).n;

  /** Seal / open the whole snapshot document. Lookup columns (id, policy_number, as_of, seq) stay clear. */
  const sealDoc = (snap) => ctx.crypto.encryptPii(JSON.stringify(snap));
  const openDoc = (tctx, stored) => JSON.parse(ctx.crypto.isEncrypted(stored) ? tctx.crypto.decryptPii(stored) : stored);

  /** Decode a policy_snapshots row; a legacy plaintext row is rewritten encrypted on first read. */
  function readRow(row) {
    if (!row) return null;
    const encrypted = ctx.crypto.isEncrypted(row.doc);
    const snap = openDoc(ctx, row.doc);
    if (!encrypted) ctx.db.run('UPDATE policy_snapshots SET doc = ? WHERE id = ?', sealDoc(snap), row.id);
    return snap;
  }

  /** Store a snapshot in policy_snapshots unless an identical one is already cached. Returns the snapshot with id. */
  function cacheSnapshot(policy, asOf) {
    const { retrievedAt: _r, id: _i, ...content } = policy;
    const latest = ctx.db.get('SELECT * FROM policy_snapshots WHERE policy_number = ? AND as_of = ? ORDER BY seq DESC LIMIT 1',
      policy.policyNumber, asOf);
    if (latest) {
      const cached = readRow(latest);
      const { retrievedAt: _r2, id: _i2, ...old } = cached;
      if (JSON.stringify(old) === JSON.stringify(content)) return cached;
    }
    const snap = { ...content, id: ctx.db.id('psn'), retrievedAt: ctx.clock.nowIso() };
    ctx.db.insert('policy_snapshots', {
      id: snap.id, policy_number: policy.policyNumber, as_of: asOf, doc: sealDoc(snap), retrieved_at: snap.retrievedAt,
      seq: nextSeq('policy_snapshots'),
    });
    return snap;
  }

  /** Idempotent: encrypt every legacy plaintext snapshot row of this tenant. Returns rows rewritten. */
  function sweepLegacySnapshots() {
    let n = 0;
    for (const row of ctx.db.all('SELECT id, doc FROM policy_snapshots')) {
      if (ctx.crypto.isEncrypted(row.doc)) continue;
      ctx.db.run('UPDATE policy_snapshots SET doc = ? WHERE id = ?', sealDoc(JSON.parse(row.doc)), row.id);
      n++;
    }
    return n;
  }

  const svc = {
    /**
     * Policy as of a date through the policy port (cached in policy_snapshots).
     * @param {{ policyNumber: string, asOf: string }} q
     * @returns {Promise<object>} PolicySnapshot; throws not_found
     */
    async getPolicySnapshot({ policyNumber, asOf }) {
      if (!policyNumber) throw new AppError('bad_request', 'policyNumber is required', 400);
      if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new AppError('bad_request', 'asOf must be a YYYY-MM-DD date', 400);
      const policy = await fetchPolicy(policyNumber, asOf);
      if (!policy) throw new AppError('not_found', 'Policy not found', 404);
      return ctx.db.transaction(() => cacheSnapshot(policy, asOf));
    },

    /**
     * Find policies by lastName, postalCode, vin and/or phone (blind-index lookup, AND semantics).
     * @returns {Promise<object[]>} PolicySummary[]
     */
    async searchPolicies(criteria = {}) {
      const keys = ['lastName', 'postalCode', 'vin', 'phone', 'policyNumberPrefix', 'vinSuffix'];
      const given = keys.filter((k) => criteria[k] !== undefined && criteria[k] !== null && String(criteria[k]).trim() !== '');
      if (!given.length) throw new AppError('bad_request', 'Provide at least one of lastName, postalCode, vin, phone', 400);
      try {
        return await adapter().search(Object.fromEntries(given.map((k) => [k, criteria[k]])));
      } catch (e) {
        if (e?.status) throw e;
        throw new AppError('upstream_error', 'Policy system unavailable', 502);
      }
    },

    /**
     * Free-text policy search for CSR / agent screens. Classifies q (VIN, phone, postal code, policy-number
     * prefix, last name), looks it up by blind index and returns masked PolicySummary rows.
     * @param {string} q
     * @returns {Promise<{ kind: string, items: object[] }>}
     */
    async searchByQuery(q, { producerId } = {}) {
      const text = typeof q === 'string' ? q.trim() : '';
      if (!text) throw new AppError('bad_request', 'q is required', 400);
      const parsed = classifyQuery(text);
      if (!parsed) {
        throw new AppError('bad_request', 'q must be a policy number or prefix (e.g. PA-IL-6671841, HO-IL), a last name, full name or business name, a phone number, a postal code, or a full VIN or its last 6 or more characters', 400);
      }
      const a = adapter();
      const run = async (criteria) => {
        const c = producerId ? { ...criteria, producerId } : criteria;
        if (typeof a.searchPage === 'function') return a.searchPage(c);
        const items = typeof a.searchSummaries === 'function' ? await a.searchSummaries(c) : await a.search(c);
        return { items, total: items.length };
      };
      try {
        let kind = parsed.kind;
        let page = await run(parsed.criteria);
        for (const alt of parsed.alternates ?? []) {
          if (page.items.length) break;
          const next = await run(alt.criteria);
          if (next.items.length) { kind = alt.kind; page = next; }
        }
        const total = Number.isInteger(page.total) ? page.total : page.items.length;
        return { kind, items: page.items, total, truncated: total > page.items.length };
      } catch (e) {
        if (e?.status) throw e;
        throw new AppError('upstream_error', 'Policy system unavailable', 502);
      }
    },

    /**
     * True when the agent produces the policy (the stored producer.agentId). Fail closed.
     * @param {string} policyNumber
     * @param {string} agentId
     */
    async isProducer(policyNumber, agentId) {
      if (!policyNumber || !agentId) return false;
      try {
        const a = adapter();
        if (typeof a.producedPolicyNumbers !== 'function') return false;
        return (await a.producedPolicyNumbers(agentId)).includes(policyNumber);
      } catch { return false; }
    },

    /** Policy numbers the agent produces ([] when the adapter has no producer data). */
    async producedPolicyNumbers(agentId) {
      try {
        const a = adapter();
        return typeof a.producedPolicyNumbers === 'function' ? await a.producedPolicyNumbers(agentId) : [];
      } catch { return []; }
    },

    /**
     * Verify a claim against the policy as of the loss date. Persists the result and publishes
     * claim.coverage.verified. When opts.sourceEventId was already processed, returns the stored result.
     * @param {string} claimId
     * @param {{ actor?: string, sourceEventId?: string }} [opts]
     */
    async verifyCoverage(claimId, opts = {}) {
      if (opts.sourceEventId) {
        const prior = ctx.db.get('SELECT doc FROM coverage_verifications WHERE source_event_id = ? AND claim_id = ?', opts.sourceEventId, claimId);
        if (prior) return JSON.parse(prior.doc);
      }
      const claim = await ctx.modules.claims.getClaim(claimId, { include: ['vehicles', 'properties'] });
      if (!claim) throw new AppError('not_found', 'Claim not found', 404);

      const loss = claim.lossEvent ?? {};
      const tz = ctx.tenant.config?.timeZone ?? 'America/Chicago';
      const lossDate = lossDateInTenantZone(loss, tz);
      const facts = {
        policyNumber: claim.policyNumber,
        lob: claim.lob,
        lossDate,
        lossCause: loss.cause,
        cargoInvolved: loss.cargoInvolved === true || (claim.properties ?? []).some((p) => p.role === 'cargo'),
        vehicles: (claim.vehicles ?? []).map((v) => ({ role: v.role, ownership: v.ownership, vin: v.vin, policyVehicleId: v.policyVehicleId })),
        properties: (claim.properties ?? []).filter((p) => p.role !== 'cargo').map((p) => ({ role: p.role, policyLocationId: p.policyLocationId })),
      };

      let policy = null;
      if (facts.policyNumber && lossDate) policy = await fetchPolicy(facts.policyNumber, lossDate);
      const verdict = lossDate ? evaluateCoverage(policy, facts)
        : evaluateCoverage(policy, { ...facts, policyNumber: null }); // no loss date: cannot verify, needs a person
      if (!lossDate) verdict.reasons.unshift('no_loss_date: claim has no loss date');

      const actor = opts.actor ?? SYSTEM_ACTOR;
      return ctx.db.transaction(() => {
        const snap = policy ? cacheSnapshot(policy, lossDate) : null;
        const now = ctx.clock.nowIso();
        const doc = {
          id: ctx.db.id('cvr'),
          tenantId: ctx.tenant.id,
          claimId,
          ...(snap ? { policySnapshotId: snap.id } : {}),
          ...(facts.policyNumber ? { policyNumber: facts.policyNumber } : {}),
          outcome: verdict.outcome,
          checks: verdict.checks,
          matchedCoverages: verdict.applicableCoverages,
          ...(verdict.deductible ? { applicableDeductible: verdict.deductible } : {}),
          reasons: verdict.reasons,
          verifiedAt: now,
          // Additive fields (contract 1.1.0)
          status: verdict.status,
          deductible: verdict.deductible,
          limits: verdict.limits,
          applicableCoverages: verdict.applicableCoverages,
        };
        ctx.db.insert('coverage_verifications', {
          id: doc.id, claim_id: claimId, outcome: doc.outcome, status: doc.status,
          source_event_id: opts.sourceEventId ?? null, doc: JSON.stringify(doc), verified_at: now,
          seq: nextSeq('coverage_verifications'),
        });
        ctx.audit.record({
          actor, action: 'coverage.verified', entityType: 'claim', entityId: claimId,
          details: { verificationId: doc.id, outcome: doc.outcome, status: doc.status },
        });
        // Ids and codes only, no PII.
        ctx.bus.publish('claim.coverage.verified', claimId, {
          claimId,
          verificationId: doc.id,
          ...(snap ? { policySnapshotId: snap.id } : {}),
          ...(facts.policyNumber ? { policyNumber: facts.policyNumber } : {}),
          outcome: doc.outcome,
          ...(policy ? { policyStatus: policy.status } : {}),
          ...(verdict.lossInPeriod === null ? {} : { lossInPeriod: verdict.lossInPeriod }),
          matchedCoverages: verdict.applicableCoverages,
          failedChecks: verdict.checks.filter((c) => !c.passed).map((c) => c.code),
        });
        return doc;
      });
    },

    /** Cached snapshot by id (used by GET /claims/{id}/coverage), or null. */
    async getSnapshotById(id) {
      return readRow(ctx.db.get('SELECT id, doc FROM policy_snapshots WHERE id = ?', id));
    },

    /** Most recent verification for a claim, or null. */
    async getLatestVerification(claimId) {
      const row = ctx.db.get('SELECT doc FROM coverage_verifications WHERE claim_id = ? ORDER BY seq DESC LIMIT 1', claimId);
      return row ? JSON.parse(row.doc) : null;
    },

    /**
     * Load synthetic policies into the policy port's store for this tenant (mock-pas only).
     * @param {object[]} policies PolicySnapshot-shaped docs (namedInsureds may carry phone)
     * @returns {Promise<{ inserted: number }>}
     */
    async seedPolicies(policies) {
      if (!Array.isArray(policies)) throw new AppError('bad_request', 'policies must be an array', 400);
      const a = adapter();
      if (typeof a.seed !== 'function') throw new AppError('not_supported', `Adapter ${a.id} does not support seeding`, 400);
      const out = await a.seed(policies);
      ctx.audit.record({ actor: SYSTEM_ACTOR, action: 'coverage.policies.seeded', details: { inserted: out.inserted } });
      return out;
    },
  };
  // Boot sweep (root ctx only): migrate legacy plaintext rows for every tenant through its tenant-bound ctx.
  if (!ctx.tenant && typeof ctx.forTenant === 'function') {
    for (const t of ctx.tenants.list()) {
      const id = typeof t === 'string' ? t : t.id;
      try {
        const tctx = ctx.forTenant(id);
        const rows = tctx.db.all('SELECT id, doc FROM policy_snapshots');
        for (const row of rows) {
          if (tctx.crypto.isEncrypted(row.doc)) continue;
          tctx.db.run('UPDATE policy_snapshots SET doc = ? WHERE id = ?', tctx.crypto.encryptPii(row.doc), row.id);
        }
      } catch (e) {
        ctx.log.error('snapshot sweep failed', { tenantId: id, error: e.message });
      }
    }
  }
  svc.sweepLegacySnapshots = sweepLegacySnapshots;
  return svc;
}
