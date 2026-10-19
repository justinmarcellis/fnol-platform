// AI layer entry point. core calls createAi(ctx) and stores the result as ctx.ai.
import { createCascade } from './cascade.mjs';
import { createInferenceLog } from './inference-log.mjs';
import { TASKS, schemaFor } from './schemas.mjs';

export { TASKS, schemaFor };

/**
 * @param {object} ctx platform ctx (root, or tenant-bound: ctx.tenant.id is then the default tenant)
 * @param {{providers?: object}} [opts] inject providers by name (tests)
 * @returns {{run: Function, forTenant: Function, tasks: string[], health: Function, log: object}}
 *   run(task, input, {tenantId?, claimId?, flags?, providers?}) ->
 *   {output, provider, model, confidence, explanation, usage, tier, unconfirmed?}
 *   claimId (callers should pass it) keys the per-claim token budget: it is stored inside ai_inference.usage and
 *   summed by log.tokensForClaim(tenantId, claimId) for the tenant's ai.maxTokensPerClaim.
 *   Tenant ai settings honoured: humanConfirmRequired, redactPiiBeforeModel, maxTokensPerClaim (see docs/ai-evaluation.md).
 *   Every call needs a tenant: opts.tenantId, ai.forTenant(id), or a tenant-bound ctx (ctx.forTenant(id).ai).
 *   Without one run() throws a typed error (code ai_tenant_required) instead of using local silently.
 */
export function createAi(ctx, opts = {}) {
  const log = createInferenceLog(ctx);
  const cascade = createCascade(ctx, { log, providers: opts.providers });
  const mk = (defaultTenant) => {
    const run = (task, input, o = {}) => cascade.run(task, input, { ...o, tenantId: o.tenantId ?? defaultTenant });
    return {
      run,
      forTenant: (tenantId) => mk(tenantId),
      tasks: [...TASKS],
      health: () => cascade.health(),
      log,
    };
  };
  const root = mk(undefined); // SEC2-010: no default tenant; run() without one throws ai_tenant_required
  // Tenant-bound contexts are Object.create(rootCtx): expose a tenant-bound `ai` through an accessor so
  // ctx.forTenant(id).ai.run(...) is attributed to that tenant. The root ctx keeps the unbound object.
  const bound = new Map();
  try {
    Object.defineProperty(ctx, 'ai', {
      configurable: true, enumerable: true,
      get() {
        const id = this?.tenant?.id;
        if (!id || this === ctx) return root;
        if (!bound.has(id)) bound.set(id, mk(id));
        return bound.get(id);
      },
      set(v) {
        // The server assigns createAi's return value (root); keep the accessor then. Any other value replaces it.
        if (v !== root) Object.defineProperty(ctx, 'ai', { value: v, writable: true, configurable: true, enumerable: true });
      },
    });
  } catch { /* frozen test ctx: the unbound object is still returned */ }
  return root;
}

export default createAi;
