import { migrations as webhookMigrations } from './webhooks/migrations.mjs';
import { createWebhookService } from './webhooks/service.mjs';
import { listOutbox } from './webhooks/outbox.mjs';
import { getWorker } from './webhooks/worker.mjs';
import { registerRoutes } from './routes.mjs';

/**
 * The adapters part (S1-INT-03) lives in ./adapters/index.mjs and may not exist yet.
 * Load it with a guarded dynamic import: only "that file is missing" is tolerated, any other
 * error (syntax error, broken import inside it) is rethrown so it is not silently hidden.
 */
async function loadAdapters() {
  try {
    return await import('./adapters/index.mjs');
  } catch (e) {
    const missing = e?.code === 'ERR_MODULE_NOT_FOUND' && /adapters[\\/]index\.mjs/.test(String(e.message));
    if (missing) return null;
    throw e;
  }
}
const adaptersModule = await loadAdapters();
const createAdapterService = adaptersModule?.createAdapterService ?? null;

// One adapter service for the root ctx (routes, bus handlers) and a lazy one per tenant-bound ctx.
const rootAdapters = new WeakMap();
function adapterServiceFor(ctx) {
  if (!createAdapterService) return Promise.resolve(null);
  if (!rootAdapters.has(ctx)) rootAdapters.set(ctx, Promise.resolve().then(() => createAdapterService(ctx)));
  return rootAdapters.get(ctx);
}

const listOf = (v) => (Array.isArray(v) ? v : v?.items ?? []);

/**
 * Integrations module service (mounted at ctx.modules.integrations).
 * Webhook functions are implemented here; adapter functions delegate to createAdapterService(ctx).
 * @param {object} ctx tenant-bound ctx (or root ctx at boot)
 */
function service(ctx) {
  const webhooks = createWebhookService(ctx);
  const adapters = () => adapterServiceFor(ctx);
  const needAdapter = async (fn) => {
    const a = await adapters();
    if (!a || typeof a[fn] !== 'function') throw new ctx.AppError('not_found', 'Adapter not found', 404);
    return a;
  };
  return {
    ...webhooks,
    /** @returns {Promise<{ items: object[], nextSequence: number }>} */
    listOutbox: (q) => listOutbox(ctx, q),
    /** @returns {Promise<object[]>} [{ id, port, format, enabled }] */
    async listAdapters() {
      const a = await adapters();
      return a?.listAdapters ? listOf(await a.listAdapters()) : [];
    },
    async previewMapping(adapterId, claimId) {
      return (await needAdapter('previewMapping')).previewMapping(adapterId, claimId);
    },
    async pushClaim(adapterId, claimId, opts) {
      return (await needAdapter('pushClaim')).pushClaim(adapterId, claimId, opts);
    },
    /** Shared delivery worker (tick(), configure({ fetch })), for ops and tests. */
    worker: getWorker(ctx),
  };
}

export default {
  name: 'integrations',
  // Adapter tables (core_sync, ...) come from the adapters module's optional `migrations` export.
  migrations: [...webhookMigrations, ...(adaptersModule?.migrations ?? [])],

  service,

  routes(router, ctx) {
    registerRoutes(router, ctx, { adapterService: () => adapterServiceFor(ctx) });
  },

  subscribe(bus, ctx) {
    const worker = getWorker(ctx);
    bus.on('*', (evt, tctx) => worker.handleEvent(evt, tctx ?? ctx.forTenant(evt.tenantId ?? evt.tenantid)), { name: 'integrations:webhooks' });
    worker.start();
    adapterServiceFor(ctx).then((a) => a?.init?.(ctx)).catch((e) => ctx.log.error('adapter service init failed', { error: e?.message }));
  },
};
