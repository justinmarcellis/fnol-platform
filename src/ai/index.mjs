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
 *   Modules pass opts.tenantId (or use ai.forTenant(id)); without a tenant only the local provider is used.
 */
export function createAi(ctx, opts = {}) {
  const log = createInferenceLog(ctx);
  const cascade = createCascade(ctx, { log, providers: opts.providers });
  const run = (task, input, o = {}) => cascade.run(task, input, { tenantId: ctx.tenant?.id, ...o });
  return {
    run,
    forTenant: (tenantId) => ({ run: (task, input, o = {}) => run(task, input, { ...o, tenantId }) }),
    tasks: [...TASKS],
    health: () => cascade.health(),
    log,
  };
}

export default createAi;
