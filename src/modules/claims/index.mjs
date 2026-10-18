import { migrations } from './schema.mjs';
import { createService } from './service.mjs';
import { registerRoutes } from './routes.mjs';

export { TRANSITIONS, checkTransition, isLegal } from './lifecycle.mjs';
export { addDuration, addBusinessDays } from './timers.mjs';

const SWEEP_MS = 30_000;
const FACT_EVENTS = ['claim.reported', 'claim.coverage.verified', 'claim.evidence.added', 'claim.evidence.extracted', 'claim.triaged', 'claim.routed'];

let rootCtx = null;
const tickers = new WeakMap();

/**
 * Timer tick across tenants: publishes claim.timer.due once at warnAt and claim.timer.breached once at dueAt,
 * then applies each definition's onBreach actions.
 * @param {Date|string|number} [now] defaults to ctx.clock.now()
 * @param {object} [ctx] root ctx; defaults to the one passed to subscribe()
 * @returns {Promise<{ due: string[], breached: string[] }>} timer ids acted on
 */
export async function sweepTimers(now, ctx = rootCtx) {
  const total = { due: [], breached: [] };
  if (!ctx) return total;
  const at = now ?? ctx.clock.now();
  for (const tenantId of ctx.tenants.list()) {
    const r = await ctx.forTenant(tenantId).modules.claims.sweepTimers(at);
    total.due.push(...r.due);
    total.breached.push(...r.breached);
  }
  return total;
}

export default {
  name: 'claims',
  migrations,

  /** Mounted at ctx.modules.claims (tenant-bound per ctx.forTenant). */
  service: (ctx) => createService(ctx),

  routes(router) {
    registerRoutes(router);
  },

  subscribe(bus, ctx) {
    rootCtx = ctx;
    const svc = (evt, tctx) => (tctx ?? ctx.forTenant(evt.tenantid ?? evt.tenantId)).modules.claims;
    for (const type of FACT_EVENTS) {
      bus.on(type, (evt, tctx) => svc(evt, tctx).applyEvent(evt), { name: `claims:${type}` });
    }
    // Timer starts and stops are driven by tenant config (startOn / stopOn), so listen to every event.
    bus.on('*', (evt, tctx) => svc(evt, tctx).applyTimerEvent(evt), { name: 'claims:timers' });

    if (tickers.has(ctx)) clearInterval(tickers.get(ctx));
    const ticker = setInterval(() => {
      sweepTimers(undefined, ctx).catch((e) => ctx.log.warn('timer sweep failed', { error: e?.message }));
    }, SWEEP_MS);
    ticker.unref();
    tickers.set(ctx, ticker);
  },
};
