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

/** Flatten a PolicySummary into a table row. Pure. */
export function summaryToRow(sum) {
  const insured = (sum?.namedInsureds ?? []).map((n) => n?.name).filter(Boolean).join(', ');
  const p = sum?.period ?? {};
  return {
    policyNumber: sum?.policyNumber ?? '',
    lob: sum?.lob ?? '',
    status: sum?.status ?? '',
    insured,
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

  const self = {
    get state() { return snap(); },
    subscribe(fn) { listeners.add(fn); fn(snap()); return () => listeners.delete(fn); },

    /** Search policies by free text. Phases: idle | searching | done | invalid | unavailable. */
    async search(input) {
      const q = normalizeQuery(input);
      state.query = String(input ?? '').trim();
      state.selected = null;
      state.error = null;
      state.matchedOn = null;
      if (!q) {
        state.phase = 'invalid'; state.results = []; state.message = t('csr.search.required'); emit();
        return [];
      }
      state.phase = 'searching'; state.message = ''; emit();
      try {
        const { rows, matchedOn } = mapSearchResponse(await api.get('/policies', { q }));
        state.results = rows; state.matchedOn = matchedOn;
        state.phase = 'done';
        state.message = rows.length ? t('csr.search.found', { count: rows.length }) : t('csr.search.empty');
      } catch (err) {
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
