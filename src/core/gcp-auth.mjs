/**
 * Shared GCP auth helper (S5-PLT-02). Zero dependency.
 * Access tokens come from the metadata server (Application Default Credentials on Cloud Run / GCE)
 * or, for local live checks, from an env override. Tokens are cached until shortly before expiry.
 * Errors never include token values or response bodies.
 *
 * Env overrides:
 *   GCP_ACCESS_TOKEN   static bearer token (e.g. from `gcloud auth print-access-token`); never cached beyond the process
 *   GCE_METADATA_HOST  alternative metadata host (default metadata.google.internal)
 */

export const METADATA_PATH = '/computeMetadata/v1/instance/service-accounts/default/token';
const SKEW_MS = 60_000;

/** Error carrying a stable code and no secrets. */
export class GcpAuthError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'GcpAuthError';
    this.code = code;
  }
}

/**
 * @param {{ fetch?: typeof fetch, env?: Record<string, string|undefined>, now?: () => number }} [opts]
 * @returns {{ getToken: () => Promise<string>, invalidate: () => void }}
 */
export function createTokenProvider(opts = {}) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  let cached = null; // { token, expiresAt }
  let inflight = null;

  async function load() {
    const host = env.GCE_METADATA_HOST || 'metadata.google.internal';
    const url = `http://${host}${METADATA_PATH}`;
    let res;
    try {
      res = await doFetch(url, { method: 'GET', headers: { 'Metadata-Flavor': 'Google' } });
    } catch (e) {
      throw new GcpAuthError('token_unreachable', `metadata token request failed: ${e?.code ?? e?.name ?? 'error'}`);
    }
    if (!res.ok) throw new GcpAuthError('token_http', `metadata token request returned HTTP ${res.status}`);
    let body;
    try { body = await res.json(); } catch { throw new GcpAuthError('token_invalid', 'metadata token response was not JSON'); }
    if (!body || typeof body.access_token !== 'string' || !body.access_token || !Number.isFinite(Number(body.expires_in))) {
      throw new GcpAuthError('token_invalid', 'metadata token response missing access_token or expires_in');
    }
    cached = { token: body.access_token, expiresAt: now() + Number(body.expires_in) * 1000 };
    return cached.token;
  }

  return {
    /** Resolve a bearer token (env override, cache, or metadata server). */
    async getToken() {
      if (env.GCP_ACCESS_TOKEN) return env.GCP_ACCESS_TOKEN;
      if (cached && now() < cached.expiresAt - SKEW_MS) return cached.token;
      inflight ??= load().finally(() => { inflight = null; });
      return inflight;
    },
    /** Drop the cached token (used after a 401). */
    invalidate() { cached = null; },
  };
}

/**
 * fetch with a bearer token; on 401 refreshes once and retries.
 * @param {string|URL} url
 * @param {RequestInit} [init]
 * @param {{ tokenProvider: { getToken: () => Promise<string>, invalidate?: () => void }, fetch?: typeof fetch }} deps
 * @returns {Promise<Response>}
 */
export async function gcpFetch(url, init = {}, deps = {}) {
  const { tokenProvider } = deps;
  if (!tokenProvider) throw new GcpAuthError('no_token_provider', 'gcpFetch requires deps.tokenProvider');
  const doFetch = deps.fetch ?? globalThis.fetch;
  const call = async () => {
    const token = await tokenProvider.getToken();
    return doFetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  };
  let res = await call();
  if (res.status === 401 && tokenProvider.invalidate) {
    tokenProvider.invalidate();
    res = await call();
  }
  return res;
}
