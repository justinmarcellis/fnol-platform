// Fake api for CSR tests (no network, no kit).
export class FakeApiError extends Error {
  constructor(status, code, message) { super(message ?? code); this.status = status; this.code = code; }
}
export function fakeApi(routes = {}) {
  const calls = [];
  const find = (method, path) => {
    if (routes[`${method} ${path}`] !== undefined) return routes[`${method} ${path}`];
    for (const [k, v] of Object.entries(routes)) {
      const [m, p] = k.split(' ');
      if (m === method && p.includes(':') && new RegExp('^' + p.replace(/:[a-zA-Z]+/g, '[^/]+') + '$').test(path)) return v;
    }
    return undefined;
  };
  const call = async (method, path, body, opts) => {
    calls.push({ method, path, body, opts });
    const h = find(method, path);
    if (h === undefined) throw new FakeApiError(0, 'service_unavailable', 'no route');
    const out = typeof h === 'function' ? await h(body, opts, path) : h;
    return structuredClone(out);
  };
  return { calls, get: (p, q) => call('GET', p, q), post: (p, b, o) => call('POST', p, b, o) };
}
export const step = (over = {}) => ({ sessionId: 's1', done: false, progress: { answered: 0, requiredRemaining: 3, percent: 0 }, question: null, ...over });
export const q = (id, over = {}) => ({ id, type: 'text', text: `Question ${id}`, required: true, ...over });
export const snapshot = (over = {}) => ({ policyNumber: 'AUT-100001', lob: 'personal_auto', status: 'in_force', period: { effectiveDate: '2026-01-01', expirationDate: '2027-01-01' }, namedInsureds: [{ name: 'Avery Testwell' }], ...over });
