// Claims-port registry. A claims-port adapter is `{ id, port: 'claims', format, map(bundle, profile, opts), send(payload, target) }`.
// `map` is pure (no I/O); `send` delivers a mapped payload and resolves `{ externalId, raw? }` or throws.

/**
 * @param {object} adapter
 * @returns {object} the same adapter, when valid
 */
export function assertClaimsPortAdapter(adapter) {
  const bad = (why) => { throw new TypeError(`invalid claims-port adapter: ${why}`); };
  if (!adapter || typeof adapter !== 'object') bad('not an object');
  if (typeof adapter.id !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(adapter.id)) bad('id must be a kebab-case string');
  if (typeof adapter.format !== 'string' || !adapter.format) bad('format is required');
  if (typeof adapter.map !== 'function') bad('map(bundle, profile, opts) is required');
  if (typeof adapter.send !== 'function') bad('send(payload, target) is required');
  return adapter;
}

/**
 * Create an adapter registry.
 * @param {object[]} [initial]
 */
export function createRegistry(initial = []) {
  const adapters = new Map();
  const registry = {
    register(adapter) {
      assertClaimsPortAdapter(adapter);
      if (adapters.has(adapter.id)) throw new Error(`adapter "${adapter.id}" is already registered`);
      adapters.set(adapter.id, adapter);
      return registry;
    },
    get: (id) => adapters.get(id) ?? null,
    list: () => [...adapters.values()],
  };
  initial.forEach((a) => registry.register(a));
  return registry;
}
