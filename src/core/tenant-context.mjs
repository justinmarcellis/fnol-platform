// Tenant-bound contexts (modules.md rule 3). Module code receives a ctx whose
// db, bus, audit, crypto and modules are already scoped to one tenant.
// Core helpers keep their explicit-tenant signatures as well, so both styles work:
//   ctx.bus.publish(type, subject, data)              bound
//   ctx.bus.publish(tenantId, type, subject, data)    explicit

/**
 * @param {object} ctx root context
 * @param {Map<string, Function>} factories module name -> service(ctx) factory
 * @returns {(tenantId: string) => object}
 */
export function createTenantBinder(ctx, factories) {
  const cache = new Map();

  return function forTenant(tenantId) {
    if (!tenantId) throw new Error('forTenant requires a tenant id');
    if (cache.has(tenantId)) return cache.get(tenantId);

    const scoped = ctx.db.forTenant(tenantId);
    const tctx = Object.create(ctx);
    tctx.root = ctx;
    tctx.tenant = { id: tenantId, get config() { return ctx.tenants.get(tenantId); } };
    tctx.db = { ...ctx.db, ...scoped, tenantId };
    tctx.bus = {
      ...ctx.bus,
      publish: (...a) => (a.length >= 4 ? ctx.bus.publish(...a) : ctx.bus.publish(tenantId, ...a)),
    };
    tctx.audit = {
      ...ctx.audit,
      record: (...a) => (typeof a[0] === 'string' ? ctx.audit.record(...a) : ctx.audit.record(tenantId, a[0])),
      list: (...a) => (typeof a[0] === 'string' ? ctx.audit.list(...a) : ctx.audit.list(tenantId, a[0] ?? {})),
    };
    tctx.crypto = {
      ...ctx.crypto,
      encryptPii: (...a) => (a.length >= 2 ? ctx.crypto.encryptPii(...a) : ctx.crypto.encryptPii(tenantId, a[0])),
      decryptPii: (...a) => (a.length >= 2 ? ctx.crypto.decryptPii(...a) : ctx.crypto.decryptPii(tenantId, a[0])),
      hmacIndex: (...a) => (a.length >= 2 ? ctx.crypto.hmacIndex(...a) : ctx.crypto.hmacIndex(tenantId, a[0])),
    };
    const services = {};
    tctx.modules = new Proxy(services, {
      get(target, name) {
        if (typeof name !== 'string') return undefined;
        if (!(name in target) && factories.has(name)) target[name] = factories.get(name)(tctx);
        return target[name];
      },
      has: (_t, name) => factories.has(name),
      ownKeys: () => [...factories.keys()],
      getOwnPropertyDescriptor: (_t, name) => (factories.has(name) ? { enumerable: true, configurable: true } : undefined),
    });
    cache.set(tenantId, tctx);
    return tctx;
  };
}
