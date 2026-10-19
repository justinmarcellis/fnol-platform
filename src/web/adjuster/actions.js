// API calls for the adjuster app. Takes an api client ({get, post, patch}), never imports the kit.
import { buildDecision } from './render.js';

/** GET the inbox. */
export function loadInbox(api, { mine = true, limit = 50 } = {}) {
  return api.get('/adjuster/inbox', { mine, limit });
}

/** GET the aggregated first view. */
export function loadView(api, claimId) {
  return api.get(`/adjuster/claims/${encodeURIComponent(claimId)}/view`);
}

/**
 * Record an accept/dismiss on a fraud or subrogation item: a categorised note
 * (the audit trail) plus a best-effort update of the matching open task.
 * @returns {Promise<{ok:boolean, error?:string, note?:object}>}
 */
export async function submitDecision(api, claimId, { kind, action, note, tasks }) {
  const built = buildDecision({ kind, action, note, tasks });
  if (!built.ok) return built;
  const id = encodeURIComponent(claimId);
  const saved = await api.post(`/claims/${id}/notes`, built.note);
  if (built.taskPatch) {
    try { await api.patch(`/claims/${id}/tasks/${encodeURIComponent(built.taskPatch.taskId)}`, { status: built.taskPatch.status }); } catch { /* the note is the record */ }
  }
  return { ok: true, note: saved };
}

/** Add a general note. */
export function addNote(api, claimId, body) {
  return api.post(`/claims/${encodeURIComponent(claimId)}/notes`, { body: String(body).trim(), category: 'general', visibility: 'internal' });
}

/** Checklist persistence is a per-viewer convenience; storage may be blocked. */
export function loadChecklist(claimId, storage = globalThis.localStorage) {
  try { return JSON.parse(storage.getItem(`adjuster.nba.${claimId}`) ?? '[]'); } catch { return []; }
}
export function saveChecklist(claimId, codes, storage = globalThis.localStorage) {
  try { storage.setItem(`adjuster.nba.${claimId}`, JSON.stringify(codes)); } catch { /* ignore */ }
}
