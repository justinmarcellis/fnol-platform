// Policy search. Pure logic: inject { api, t, clock }. No kit imports.
//
// openapi.yaml has no free-text policy search route. The endpoint used is
//   GET /policies/{policyNumber}/snapshot?asOf=YYYY-MM-DD   (operationId getPolicySnapshot, "CSR intake helper")
// which looks a policy up by exact number. The result list therefore holds 0 or 1 rows.
import { isUnavailable, isoDate } from './errors.js';

const POLICY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;

/** Normalise user input to a policy number, or null when it is not plausible. */
export function normalizePolicyNumber(input) {
  const v = String(input ?? '').trim().toUpperCase();
  return POLICY_RE.test(v) ? v : null;
}

/** Flatten a PolicySnapshot into a table row. Pure. */
export function snapshotToRow(snap) {
  const insured = snap?.namedInsureds?.[0]?.name ?? '';
  const p = snap?.period ?? {};
  return {
    policyNumber: snap?.policyNumber ?? '',
    lob: snap?.lob ?? '',
    status: snap?.status ?? '',
    insured,
    period: p.effectiveDate && p.expirationDate ? `${p.effectiveDate} - ${p.expirationDate}` : '',
    snapshot: snap,
  };
}

/**
 * @param {{ api: any, t: (k:string,p?:object)=>string, clock?: {now():number} }} deps
 */
export function createPolicySearch({ api, t, clock = { now: () => Date.now() } }) {
  const state = { phase: 'idle', query: '', results: [], selected: null, error: null, message: '' };
  const listeners = new Set();
  const snap = () => ({ ...state, results: [...state.results] });
  const emit = () => { const s = snap(); for (const l of listeners) l(s); };

  const self = {
    get state() { return snap(); },
    subscribe(fn) { listeners.add(fn); fn(snap()); return () => listeners.delete(fn); },

    /** Look up a policy. Phases: idle | searching | done | invalid | unavailable. */
    async search(input) {
      const policyNumber = normalizePolicyNumber(input);
      state.query = String(input ?? '').trim();
      state.selected = null;
      state.error = null;
      if (!policyNumber) {
        state.phase = 'invalid'; state.results = []; state.message = t('csr.search.required'); emit();
        return [];
      }
      state.phase = 'searching'; state.message = ''; emit();
      try {
        const snapshot = await api.get(`/policies/${encodeURIComponent(policyNumber)}/snapshot`, { asOf: isoDate(clock) });
        state.results = snapshot ? [snapshotToRow(snapshot)] : [];
        state.phase = 'done';
        state.message = state.results.length ? t('csr.search.found', { count: state.results.length }) : t('csr.search.empty');
      } catch (err) {
        if (isUnavailable(err)) {
          state.phase = 'unavailable'; state.results = []; state.message = t('csr.unavailable.body');
          state.error = { code: err?.code ?? 'service_unavailable', status: err?.status };
        } else if (err?.status === 404 || err?.code === 'not_found') {
          state.phase = 'done'; state.results = []; state.message = t('csr.search.empty');
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
