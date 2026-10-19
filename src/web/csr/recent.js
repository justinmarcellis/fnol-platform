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

/** Severity bands on the 0-100 triage score (tenant severityBands: moderate 25, major 50, severe 75). */
export const SEVERITY_BANDS = Object.freeze({ moderate: 25, major: 50, severe: 75 });

/** Band name for a 0-100 severity score: minor | moderate | major | severe, or null. Pure. */
export function severityBand(score, bands = SEVERITY_BANDS) {
  const n = Number(score);
  if (score == null || score === '' || !Number.isFinite(n)) return null;
  if (n >= bands.severe) return 'severe';
  if (n >= bands.major) return 'major';
  if (n >= bands.moderate) return 'moderate';
  return 'minor';
}

/** "45 of 100 (Moderate)". Pure. */
export function severityText(score, t) {
  const band = severityBand(score);
  return band ? t('csr.claim.severityValue', { score: Math.round(Number(score)), band: t(`csr.severity.${band}`) }) : '';
}

const MAX_SUMMARY = 160;
/** First sentence(s) of a description, cut at a word boundary to about 160 characters. Pure. */
export function descriptionSummary(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= MAX_SUMMARY) return s;
  const cut = s.slice(0, MAX_SUMMARY);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 80)).replace(/[,;:.]$/, '')}…`;
}

/** Display name of the claim's insured party (parties[] with role insured), or ''. Pure. */
export function insuredName(c) {
  const p = (Array.isArray(c?.parties) ? c.parties : []).find((x) => (x?.roles ?? []).includes('insured'));
  if (!p) return '';
  return p.displayName || p.name || p.organizationName || [p.firstName, p.lastName].filter(Boolean).join(' ');
}

/** Read-only summary fields of a claim: [{key,label,value}]. Pure; the insured's name only, no other PII. */
export function claimSummary(c, t) {
  const none = t('csr.claim.none');
  const sev = severityText(c?.triage?.severityScore, t);
  return [
    { key: 'status', label: t('csr.claim.status'), value: c?.status || none },
    { key: 'lob', label: t('csr.claim.lob'), value: c?.lob || none },
    { key: 'policyNumber', label: t('csr.claim.policy'), value: c?.policyNumber || none },
    { key: 'insured', label: t('csr.claim.insured'), value: insuredName(c) || none },
    { key: 'lossDate', label: t('csr.claim.lossDate'), value: c?.lossEvent?.lossDate || none },
    { key: 'description', label: t('csr.claim.description'), value: descriptionSummary(c?.lossEvent?.description) || none },
    { key: 'reportedAt', label: t('csr.claim.reported'), value: c?.reportedAt || none },
    { key: 'channel', label: t('csr.claim.channel'), value: c?.channel || none },
    { key: 'severity', label: t('csr.claim.severity'), value: sev || none },
  ];
}

/** Message for a list or claim load that failed (not "unavailable"): 403 forbidden, 404 not found, else generic. Pure. */
export function failureMessage(kind, error, t) {
  const what = kind === 'open' ? 'claim' : 'list';
  if (error?.status === 403) return t(`csr.recent.forbidden.${what}`);
  if (error?.status === 404) return t(`csr.recent.notFound.${what}`);
  return t(`csr.recent.failed.${what}`);
}

/** Claim statuses the intake pipeline moves through on its own right after submit. */
export const TRANSIENT_STATUSES = Object.freeze(['reported', 'validating', 'triaged']);

/**
 * @param {{ api: any, t: (k:string,p?:object)=>string }} deps
 */
export function createRecent({ api, t }) {
  const state = { phase: 'idle', kind: null, rows: [], claim: null, error: null, message: '' };
  const listeners = new Set();
  const snap = () => ({ ...state, rows: [...state.rows] });
  const emit = () => { const s = snap(); for (const l of listeners) l(s); };
  let last = null;

  async function guarded(kind, arg, fn) {
    last = { kind, arg };
    state.phase = 'loading'; state.kind = kind; state.error = null; state.message = ''; emit();
    try { await fn(); state.phase = 'done'; }
    catch (err) {
      state.error = { code: err?.code ?? 'error', status: err?.status };
      state.phase = isUnavailable(err) ? 'unavailable' : 'failed';
      state.message = failureMessage(kind, state.error, t);
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
      return guarded('open', id, async () => {
        state.claim = null;
        state.claim = await api.get(`/claims/${encodeURIComponent(id)}`, { include: 'parties' });
      });
    },
    /**
     * After a submit the intake pipeline settles the claim (validating -> triaged -> assigned) a moment later. Reload the
     * list until the claim's row shows a settled status, at most `delays.length` more times.
     * @param {string} claimId
     * @param {{ delays?: number[], sleep?: (ms:number)=>Promise<void> }} [opts]
     */
    async refreshUntilSettled(claimId, { delays = [800, 1500, 3000, 5000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
      const settled = () => {
        const row = state.rows.find((r) => r.id === claimId);
        return !!row && !TRANSIENT_STATUSES.includes(row.status);
      };
      await self.load();
      for (const ms of delays) {
        if (settled() || state.phase !== 'done') break;
        await sleep(ms);
        await self.load();
      }
      return settled();
    },
    retry() { return last ? (last.kind === 'open' ? self.open(last.arg) : self.load(last.arg)) : Promise.resolve(); },
  };
  return self;
}
