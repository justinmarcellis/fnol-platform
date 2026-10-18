// Shared API client. Zero dependencies; safe to import in node.

/** Error thrown for every non-2xx or failed request. */
export class ApiError extends Error {
  /**
   * @param {{status?:number, code?:string, message?:string, details?:Array, requestId?:string}} p
   */
  constructor({ status = 0, code = 'internal', message = 'Request failed', details = [], requestId } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

/**
 * Build an ApiError from a status and parsed body (pure; exported for tests).
 * Network failures, 5xx and non-envelope 404s map to 'service_unavailable'.
 * @param {number} status
 * @param {any} body
 */
export function toApiError(status, body) {
  const env = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
  if (status >= 500 || (status === 404 && !env)) {
    return new ApiError({
      status,
      code: 'service_unavailable',
      message: env?.message ?? 'Service unavailable',
      details: env?.details ?? [],
      requestId: env?.requestId,
    });
  }
  if (env) {
    return new ApiError({ status, code: env.code ?? 'internal', message: env.message ?? 'Request failed', details: env.details ?? [], requestId: env.requestId });
  }
  return new ApiError({ status, code: status === 401 ? 'unauthorized' : 'internal', message: `Request failed (${status})` });
}

/** Append query params, skipping null/undefined. */
export function buildUrl(baseUrl, path, query) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  let qs = '';
  if (query && typeof query === 'object') {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) sp.append(k, String(v));
    const s = sp.toString();
    if (s) qs = `?${s}`;
  }
  return `${base}${p}${qs}`;
}

/**
 * @param {{baseUrl?:string, getToken?:()=>(string|null|undefined|Promise<string|null|undefined>), fetchImpl?:Function}} [opts]
 */
export function createApiClient({ baseUrl = '/api/v1', getToken, fetchImpl } = {}) {
  async function request(method, path, { body, query, headers = {}, raw } = {}) {
    const doFetch = fetchImpl ?? globalThis.fetch;
    const h = { accept: 'application/json', ...headers };
    const token = getToken ? await getToken() : null;
    if (token) h.authorization = `Bearer ${token}`;
    let payload = raw;
    if (raw === undefined && body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await doFetch(buildUrl(baseUrl, path, query), { method, headers: h, body: payload });
    } catch (e) {
      throw new ApiError({ status: 0, code: 'service_unavailable', message: 'Network unavailable' });
    }
    let data = null;
    const text = typeof res.text === 'function' ? await res.text() : '';
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!res.ok) throw toApiError(res.status, data);
    return data;
  }
  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
    put: (path, body) => request('PUT', path, { body }),
    patch: (path, body) => request('PATCH', path, { body }),
    del: (path) => request('DELETE', path),
    /**
     * Multipart upload. `file` is a Blob/File; `fields` are extra form fields.
     * @param {string} path
     * @param {Blob} file
     * @param {Record<string,string>} [fields]
     */
    upload: (path, file, fields = {}) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
      fd.append('file', file, file?.name ?? 'upload');
      return request('POST', path, { raw: fd });
    },
  };
}
