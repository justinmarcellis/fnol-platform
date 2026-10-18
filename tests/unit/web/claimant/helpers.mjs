// Fake api and fake timers for claimant tests.
export class FakeApiError extends Error {
  constructor(status, code, message) { super(message ?? code); this.status = status; this.code = code; }
}

/** Fake api. `routes` maps "METHOD /path" (or a RegExp-ish prefix key) to a handler(body, opts) or value. */
export function fakeApi(routes = {}) {
  const calls = [];
  const find = (method, path) => {
    const exact = routes[`${method} ${path}`];
    if (exact !== undefined) return exact;
    for (const [k, v] of Object.entries(routes)) {
      if (!k.includes(':')) continue;
      const [m, p] = k.split(' ');
      if (m !== method) continue;
      const re = new RegExp('^' + p.replace(/:[a-zA-Z]+/g, '[^/]+') + '$');
      if (re.test(path)) return v;
    }
    return undefined;
  };
  const call = async (method, path, body, opts) => {
    calls.push({ method, path, body, opts });
    const h = find(method === 'UPLOAD' ? 'POST' : method, path);
    if (h === undefined) throw new FakeApiError(0, 'service_unavailable', 'no route');
    const out = typeof h === 'function' ? await h(body, opts, path) : h;
    return structuredClone(out);
  };
  return {
    calls, routes,
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b, o),
    upload: (p, form) => call('UPLOAD', p, form),
  };
}

export function fakeTimers() {
  let id = 0; let now = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { id += 1; pending.set(id, { fn, at: now + ms, ms }); return id; },
    clearTimeout: (h) => { pending.delete(h); },
    get pending() { return [...pending.values()]; },
    get count() { return pending.size; },
    /** Fire the earliest timer, return its delay. */
    async fireNext() {
      const [h, t] = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (h === undefined) return null;
      pending.delete(h); now = t.at; await t.fn(); return t.ms;
    }
  };
}

export const step = (over = {}) => ({ sessionId: 's1', done: false, progress: { answered: 0, requiredRemaining: 2, percent: 0 }, question: null, ...over });
export const q = (id, over = {}) => ({ id, type: 'text', text: `Question ${id}`, required: true, ...over });
