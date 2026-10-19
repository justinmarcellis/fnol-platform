// Policy port: the seam between the coverage module and a carrier policy admin
// system (PAS). A real carrier adds an adapter here; only mock-pas is built in.
//
// Adapter interface:
//   { id: string,
//     getPolicy({ policyNumber, asOf }) -> Promise<PolicySnapshot-without-id|null>,
//     search(criteria) -> Promise<PolicySummary[]>,
//     seed?(policies[]) -> Promise<{ inserted }> }
// getPolicy resolves null when the policy does not exist. Any thrown error is
// treated as an upstream failure (502).

import { createMockPas } from './adapters/mock-pas.mjs';

export const DEFAULT_ADAPTER = 'mock-pas';

const factories = new Map([[DEFAULT_ADAPTER, createMockPas]]);

/** Register an additional policy adapter factory: (tctx, settings) -> adapter. */
export function registerAdapter(id, factory) {
  factories.set(id, factory);
}

/**
 * Resolve the adapter for the tenant bound to ctx (TenantConfig.integrations.policyPort.adapter).
 * @param {object} ctx tenant-bound context
 */
export function resolveAdapter(ctx) {
  const cfg = ctx.tenant?.config?.integrations?.policyPort ?? {};
  const id = cfg.adapter ?? DEFAULT_ADAPTER;
  const factory = factories.get(id);
  if (!factory) throw new ctx.AppError('upstream_error', `Policy adapter '${id}' is not available`, 502);
  return factory(ctx, cfg.settings ?? {});
}
