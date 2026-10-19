// Admin console API actions. Uses an injected fetch so unit tests need no server.
// Unlike the shared client, every HTTP status is returned (not thrown) because the console
// reads 404/409/422 bodies; only a network failure throws.
import { ApiError, buildUrl } from '../shared/api.js';
import { ifMatch, normalizeHistory, normalizeReport, parseEtag } from './config-model.js';

/**
 * @param {{baseUrl?:string, getToken?:()=>(string|null), fetchImpl?:Function}} [opts]
 */
export function createAdminClient({ baseUrl = '/api/v1', getToken, fetchImpl } = {}) {
  /** @returns {Promise<{status:number, ok:boolean, body:any, etag:number|null}>} */
  async function call(method, path, { body, headers = {}, query } = {}) {
    const doFetch = fetchImpl ?? globalThis.fetch;
    const h = { accept: 'application/json', ...headers };
    const token = getToken ? getToken() : null;
    if (token) h['x-fnol-authorization'] = `Bearer ${token}`; // IAP rejects app tokens in Authorization;
    let payload;
    if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    let res;
    try { res = await doFetch(buildUrl(baseUrl, path, query), { method, headers: h, body: payload }); } catch {
      throw new ApiError({ status: 0, code: 'service_unavailable', message: 'Network unavailable' });
    }
    let parsed = null;
    const text = typeof res.text === 'function' ? await res.text() : '';
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
    const etag = parseEtag(res.headers?.get ? res.headers.get('etag') : null);
    return { status: res.status, ok: res.ok, body: parsed, etag };
  }

  const fail = (r) => new ApiError({
    status: r.status, code: r.body?.error?.code ?? (r.status === 401 ? 'unauthorized' : 'internal'),
    message: r.body?.error?.message ?? `Request failed (${r.status})`,
  });
  const must = (r) => { if (!r.ok) throw fail(r); return r; };

  return {
    call,

    /** Sign in with the dev token endpoint. @returns {Promise<string>} token */
    async devLogin({ tenant, userId = 'dev-tenant-admin', name = 'Dev tenant admin' }) {
      const r = must(await call('POST', '/auth/token', { body: { tenantId: tenant, userId, sub: userId, roles: ['tenant_admin'], displayName: name, name } }));
      return r.body.token;
    },

    /** GET /config -> {config, version} (version from ETag, else config.version). */
    async loadConfig() {
      const r = must(await call('GET', '/config'));
      return { config: r.body, version: r.etag ?? r.body?.version ?? 0 };
    },

    /** POST /config/validate -> normalised report (labels name items from the config being validated). */
    async validate(config) {
      const r = must(await call('POST', '/config/validate', { body: config }));
      return normalizeReport(r.body, config);
    },

    /**
     * Validate, then PUT with If-Match. Outcomes: saved | invalid | conflict.
     * @returns {Promise<{outcome:'saved'|'invalid'|'conflict', report?:object, config?:object, version?:number, message?:string}>}
     */
    async save(config, version) {
      const report = await this.validate(config);
      if (!report.valid) return { outcome: 'invalid', report };
      const r = await call('PUT', '/config', { body: config, headers: { 'if-match': ifMatch(version) } });
      if (r.status === 409) return { outcome: 'conflict', message: r.body?.error?.message ?? 'The configuration changed since you loaded it.' };
      if (r.status === 422) return { outcome: 'invalid', report: normalizeReport(r.body, config) };
      must(r);
      return { outcome: 'saved', config: r.body, version: r.etag ?? r.body?.version ?? version + 1 };
    },

    /**
     * Version history from GET /config/versions (every version from 1, with the saver's name).
     * The config module always serves it, so there is no second request and no audit fallback.
     * @returns {Promise<{available:boolean, source:string, rows:Array}>}
     */
    async loadHistory() {
      const v = must(await call('GET', '/config/versions'));
      return { available: true, source: 'versions', rows: normalizeHistory(v.body) };
    },

    /** GET /kpis; a 404 (module not deployed) yields {available:false}. */
    async loadKpis(range = {}) {
      const r = await call('GET', '/kpis', { query: range });
      if (r.status === 404) return { available: false, body: null };
      return { available: true, body: must(r).body };
    },

    // ---- webhooks (integrations module)
    async listWebhooks() {
      const r = await call('GET', '/integrations/webhooks');
      if (r.status === 404) return { available: false, items: [] };
      return { available: true, items: must(r).body?.items ?? [] };
    },
    async createWebhook({ url, eventTypes, description }) {
      const r = await call('POST', '/integrations/webhooks', { body: { url, eventTypes, ...(description ? { description } : {}), active: true } });
      if (r.status === 422 || r.status === 400) return { ok: false, message: r.body?.error?.message ?? 'Webhook rejected', details: r.body?.error?.details ?? [] };
      return { ok: true, webhook: must(r).body };
    },
    async setWebhookActive(id, active) { return must(await call('PATCH', `/integrations/webhooks/${encodeURIComponent(id)}`, { body: { active } })).body; },
    async deleteWebhook(id) { must(await call('DELETE', `/integrations/webhooks/${encodeURIComponent(id)}`)); return true; },
  };
}
