// Policy search. Pure logic: inject { api, t }. No kit imports.
//
// Uses GET /policies?q=<text> (operationId searchPolicies, contract 1.2.0). The server classifies q (VIN, postal
// code, phone, policy-number prefix, else last name) and returns { items: PolicySummary[], matchedOn }.
import { isUnavailable } from './errors.js';

/** Trim the free-text query; null when empty or over the contract's 100 character limit. */
export function normalizeQuery(input) {
  const v = String(input ?? '').trim();
  return v && v.length <= 100 ? v : null;
}

/**
 * How to send a query to GET /policies?q=. The server only classifies single-segment prefixes (letters, dash, digits),
 * so a tenant policy number or a two-segment prefix (HO-IL-1030185, PA-WI) would be read as a last name or refused.
 * Those are sent as their leading segment ('HO-') and the rows are filtered by the typed prefix on the client.
 * @returns {{ q: string, prefix: string|null }}
 */
export function planQuery(q) {
  const m = /^([A-Za-z]{2,5})-([A-Za-z]{2})(-\d*)?$/.exec(q);
  if (!m) return { q, prefix: null };
  return { q: `${m[1].toUpperCase()}-`, prefix: q.toUpperCase() };
}

/** Flatten a PolicySummary into a table row. Pure. */
export function summaryToRow(sum) {
  // GET /policies returns insuredName (PolicySummary); namedInsureds[] is accepted too.
  const insured = (sum?.namedInsureds ?? []).map((n) => n?.name).filter(Boolean).join(', ') || (sum?.insuredName ?? '');
  const p = sum?.period ?? {};
  return {
    policyNumber: sum?.policyNumber ?? '',
    lob: sum?.lob ?? '',
    status: sum?.status ?? '',
    insured,
    description: sum?.description ?? '',
    period: p.effectiveDate && p.expirationDate ? `${p.effectiveDate} - ${p.expirationDate}` : '',
    summary: sum,
  };
}

/** Map a { items, matchedOn } response to { rows, matchedOn }. Tolerates a missing or malformed body. */
export function mapSearchResponse(res) {
  const items = Array.isArray(res?.items) ? res.items : [];
  return { rows: items.map(summaryToRow), matchedOn: typeof res?.matchedOn === 'string' ? res.matchedOn : null };
}

/**
 * @param {{ api: any, t: (k:string,p?:object)=>string }} deps
 */
export function createPolicySearch({ api, t }) {
  const state = { phase: 'idle', query: '', matchedOn: null, results: [], selected: null, error: null, message: '' };
  const listeners = new Set();
  const snap = () => ({ ...state, results: [...state.results] });
  const emit = () => { const s = snap(); for (const l of listeners) l(s); };
  // Type-ahead fires overlapping searches; only the newest one may write state (a slow older response must not win).
  let seq = 0;

  const self = {
    get state() { return snap(); },
    subscribe(fn) { listeners.add(fn); fn(snap()); return () => listeners.delete(fn); },

    /** Search policies by free text. Phases: idle | searching | done | invalid | unavailable. */
    async search(input) {
      const mine = ++seq;
      const q = normalizeQuery(input);
      state.query = String(input ?? '').trim();
      state.selected = null;
      state.error = null;
      state.matchedOn = null;
      if (!q) {
        state.phase = 'invalid'; state.results = []; state.message = t('csr.search.required'); emit();
        return [];
      }
      if (q.length < 2) { // the server needs at least two characters for any kind of search
        state.phase = 'invalid'; state.results = []; state.message = t('csr.search.tooShort'); emit();
        return [];
      }
      const plan = planQuery(q);
      state.phase = 'searching'; state.message = ''; emit();
      try {
        const res = mapSearchResponse(await api.get('/policies', { q: plan.q }));
        if (mine !== seq) return self.state.results;
        const rows = plan.prefix ? res.rows.filter((r) => String(r.policyNumber).toUpperCase().startsWith(plan.prefix)) : res.rows;
        const matchedOn = res.matchedOn;
        state.results = rows; state.matchedOn = matchedOn;
        state.phase = 'done';
        state.message = rows.length ? t('csr.search.found', { count: rows.length }) : t('csr.search.empty');
      } catch (err) {
        if (mine !== seq) return self.state.results;
        if (isUnavailable(err)) {
          state.phase = 'unavailable'; state.results = []; state.message = t('csr.unavailable.body');
          state.error = { code: err?.code ?? 'service_unavailable', status: err?.status };
        } else if (err?.status === 400 || err?.code === 'bad_request') {
          state.phase = 'invalid'; state.results = []; state.message = t('csr.search.unclassified');
          state.error = { code: err?.code ?? 'bad_request', status: err?.status };
        } else {
          state.phase = 'done'; state.results = [];
          state.error = { code: err?.code ?? 'error', status: err?.status };
          state.message = t('csr.error.generic', { message: err?.message ?? '' });
        }
      }
      emit();
      return self.state.results;
    },

    /** Forget results and message (the query box was emptied). Also drops any search still in flight. */
    clear() {
      seq += 1;
      Object.assign(state, { phase: 'idle', query: '', matchedOn: null, results: [], selected: null, error: null, message: '' });
      emit();
    },

    /** Re-run the last search after "service unavailable". */
    retry() { return self.search(state.query); },

    /** Pick a result row (by policy number or row). Returns the row or null. */
    select(rowOrNumber) {
      const n = typeof rowOrNumber === 'string' ? rowOrNumber : rowOrNumber?.policyNumber;
      state.selected = state.results.find((r) => r.policyNumber === n) ?? null;
      emit();
      return state.selected;
    },
  };
  return self;
}
