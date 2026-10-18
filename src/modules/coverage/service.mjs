// Coverage service: policy port access, verification, persistence and events.
import { resolveAdapter } from './port.mjs';
import { evaluateCoverage } from './verify.mjs';
import { lossDateInTenantZone } from './dates.mjs';

const SYSTEM_ACTOR = 'system:coverage';

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

  /** Store a snapshot in policy_snapshots unless an identical one is already cached. Returns the snapshot with id. */
  function cacheSnapshot(policy, asOf) {
    const { retrievedAt: _r, id: _i, ...content } = policy;
    const latest = ctx.db.get('SELECT * FROM policy_snapshots WHERE policy_number = ? AND as_of = ? ORDER BY seq DESC LIMIT 1',
      policy.policyNumber, asOf);
    if (latest) {
      const { retrievedAt: _r2, id: _i2, ...old } = JSON.parse(latest.doc);
      if (JSON.stringify(old) === JSON.stringify(content)) return JSON.parse(latest.doc);
    }
    const snap = { ...content, id: ctx.db.id('psn'), retrievedAt: ctx.clock.nowIso() };
    ctx.db.insert('policy_snapshots', {
      id: snap.id, policy_number: policy.policyNumber, as_of: asOf, doc: JSON.stringify(snap), retrieved_at: snap.retrievedAt,
      seq: nextSeq('policy_snapshots'),
    });
    return snap;
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
      const keys = ['lastName', 'postalCode', 'vin', 'phone'];
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
        vehicles: (claim.vehicles ?? []).map((v) => ({ role: v.role, vin: v.vin, policyVehicleId: v.policyVehicleId })),
        properties: (claim.properties ?? []).map((p) => ({ role: p.role, policyLocationId: p.policyLocationId })),
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
      const row = ctx.db.get('SELECT doc FROM policy_snapshots WHERE id = ?', id);
      return row ? JSON.parse(row.doc) : null;
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
  return svc;
}
