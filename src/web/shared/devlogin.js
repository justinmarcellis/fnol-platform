// Development-only login helper. Never available outside dev mode.

/** Dev mode = localhost host or explicit global flag window.__FNOL_DEV__ === true. */
export function isDevMode(env = globalThis) {
  if (env.__FNOL_DEV__ === true) return true;
  if (env.__FNOL_DEV__ === false) return false;
  const host = env.location?.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/**
 * POST /auth/token for a tenant and role. Resolves to {token, claims}.
 * @param {{post:Function}} api
 * @param {{tenant:string, role:string, userId?:string, name?:string, claimIds?:string[]}} p
 * @param {{dev?:boolean}} [opts] override dev detection (tests)
 */
export async function devLogin(api, { tenant, role, userId, name, claimIds } = {}, opts = {}) {
  const dev = opts.dev ?? isDevMode();
  if (!dev) throw new Error('Dev login is only available in dev mode');
  if (!tenant || !role) throw new Error('tenant and role are required');
  const sub = userId ?? `dev-${role}`;
  const body = {
    tenantId: tenant,
    userId: sub, // contract field
    sub, // field read by the current core implementation
    roles: [role],
    displayName: name ?? `Dev ${role}`,
    name: name ?? `Dev ${role}`,
  };
  if (claimIds) body.claimIds = claimIds;
  return api.post('/auth/token', body);
}
