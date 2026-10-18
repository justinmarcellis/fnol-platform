// Fakes for the modules intake depends on: rules (condition language delegated to the real pure evaluator) and claims.
import { evaluateCondition } from '../../../src/modules/rules/condition.js';

export const store = { claims: new Map(), byKey: new Map(), calls: [] };
export const reset = () => { store.claims.clear(); store.byKey.clear(); store.calls.length = 0; };

export const fakes = {
  rules: {
    name: 'rules',
    service: (ctx) => ({
      evaluateCondition,
      // Minimal stage evaluator over tenant rules (the real engine is tested in tests/unit/rules).
      async evaluate({ stage, facts }) {
        const actions = [];
        for (const r of ctx.tenant.config.rules ?? []) {
          if (r.stage !== stage || r.enabled === false) continue;
          if (evaluateCondition(r.when, facts).result) actions.push(...r.then);
        }
        return { fired: [], actions, trace: [] };
      },
    }),
  },
  claims: {
    name: 'claims',
    service: (ctx) => ({
      async createClaim(input, opts = {}) {
        const k = `${ctx.tenant.id}:${opts.idempotencyKey ?? ''}`;
        store.calls.push({ tenant: ctx.tenant.id, input: structuredClone(input), opts });
        if (opts.idempotencyKey && store.byKey.has(k)) return structuredClone(store.byKey.get(k));
        const id = `clm_${String(store.claims.size + 1).padStart(20, '0')}`;
        const claim = { id, tenantId: ctx.tenant.id, claimNumber: `TST-${store.claims.size + 1}`, status: 'reported', lob: input.lob, channel: input.channel, intakeSessionId: input.intakeSessionId };
        store.claims.set(`${ctx.tenant.id}:${id}`, claim);
        if (opts.idempotencyKey) store.byKey.set(k, claim);
        return structuredClone(claim);
      },
      async getClaim(id) {
        const c = store.claims.get(`${ctx.tenant.id}:${id}`);
        if (!c) throw new ctx.AppError('not_found', 'Claim not found', 404);
        return structuredClone(c);
      },
    }),
  },
};
