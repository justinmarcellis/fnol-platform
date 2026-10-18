// Recent claims list and read-only claim summary. Pure logic: inject { api, t }. No kit imports.
import { isUnavailable } from './errors.js';

/** Table columns for fx-table (labels come from t). */
export function recentColumns(t) {
  return [
    { key: 'claimNumber', label: t('csr.recent.col.number') },
    { key: 'status', label: t('csr.recent.col.status') },
    { key: 'lob', label: t('csr.recent.col.lob') },
    { key: 'policyNumber', label: t('csr.recent.col.policy') },
    { key: 'reportedAt', label: t('csr.recent.col.reported') },
  ];
}

/** Reduce a Claim to the table row. Pure. */
export function claimRow(c) {
  return { id: c.id, claimNumber: c.claimNumber ?? '', status: c.status ?? '', lob: c.lob ?? '', policyNumber: c.policyNumber ?? '', reportedAt: c.reportedAt ?? '' };
}

/** Read-only summary fields of a claim: [{key,label,value}]. Pure; no parties or PII. */
export function claimSummary(c, t) {
  const none = t('csr.claim.none');
  return [
    { key: 'status', label: t('csr.claim.status'), value: c?.status || none },
    { key: 'lob', label: t('csr.claim.lob'), value: c?.lob || none },
    { key: 'policyNumber', label: t('csr.claim.policy'), value: c?.policyNumber || none },
    { key: 'reportedAt', label: t('csr.claim.reported'), value: c?.reportedAt || none },
    { key: 'channel', label: t('csr.claim.channel'), value: c?.channel || none },
    { key: 'severity', label: t('csr.claim.severity'), value: c?.triage?.severityScore != null ? String(c.triage.severityScore) : none },
  ];
}

/**
 * @param {{ api: any, t: (k:string,p?:object)=>string }} deps
 */
export function createRecent({ api, t }) {
  const state = { phase: 'idle', rows: [], claim: null, error: null };
  const listeners = new Set();
  const snap = () => ({ ...state, rows: [...state.rows] });
  const emit = () => { const s = snap(); for (const l of listeners) l(s); };
  let last = null;

  async function guarded(kind, arg, fn) {
    last = { kind, arg };
    state.phase = 'loading'; state.error = null; emit();
    try { await fn(); state.phase = 'done'; }
    catch (err) {
      state.error = { code: err?.code ?? 'error', status: err?.status };
      state.phase = isUnavailable(err) ? 'unavailable' : 'failed';
    }
    emit();
  }

  const self = {
    get state() { return snap(); },
    subscribe(fn) { listeners.add(fn); fn(snap()); return () => listeners.delete(fn); },
    /** GET /claims?limit&sort=-reportedAt */
    load(limit = 10) {
      return guarded('list', limit, async () => {
        const page = await api.get('/claims', { limit, sort: '-reportedAt' });
        state.rows = (page?.items ?? []).map(claimRow);
      });
    },
    /** GET /claims/{id} */
    open(id) {
      return guarded('open', id, async () => { state.claim = await api.get(`/claims/${encodeURIComponent(id)}`); });
    },
    retry() { return last ? (last.kind === 'open' ? self.open(last.arg) : self.load(last.arg)) : Promise.resolve(); },
  };
  return self;
}
