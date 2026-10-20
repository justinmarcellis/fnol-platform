// API calls for the adjuster app. Takes an api client ({get, post, patch}), never imports the kit.
import { buildDecision } from './render.js';
import { insuredName } from './model.js';

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

/** GET the display directory (adjuster names, queues, rule names). Never fails: an empty directory is the fallback. */
export async function loadDirectory(api) {
  try {
    const d = await api.get('/adjuster/directory');
    return { people: d?.people ?? {}, queues: d?.queues ?? [], rules: d?.rules ?? {} };
  } catch { return { people: {}, queues: [], rules: {} }; }
}

/** POST a status move. Closing needs a closeReason (the server validates every move against the lifecycle). */
export function changeStatus(api, claimId, { to, reason, closeReason } = {}) {
  return api.post(`/claims/${encodeURIComponent(claimId)}/status`, { to, ...(reason ? { reason } : {}), ...(closeReason ? { closeReason } : {}) });
}

/** PATCH a task's status (open, in_progress, done, cancelled). */
export function updateTask(api, claimId, taskId, status) {
  return api.patch(`/claims/${encodeURIComponent(claimId)}/tasks/${encodeURIComponent(taskId)}`, { status });
}

/**
 * Ask the claimant for information: a contact note shared with the claimant, then, when the claim is
 * in review (or assigned, which starts the review first), a move to pending_info so the queue shows it is waiting on the claimant.
 * @returns {Promise<{ok:true, note:object, moved:boolean}>}
 */
export async function requestInfo(api, claimId, { body, status } = {}) {
  const id = encodeURIComponent(claimId);
  const note = await api.post(`/claims/${id}/notes`, { body: String(body).trim(), category: 'contact', visibility: 'shared_with_claimant' });
  let moved = false;
  // Journey: from an assigned claim the adjuster starts the review and asks in one step.
  if (status === 'assigned') { await api.post(`/claims/${id}/status`, { to: 'in_review', reason: 'adjuster review started' }); status = 'in_review'; }
  if (status === 'in_review') {
    await api.post(`/claims/${id}/status`, { to: 'pending_info', reason: 'awaiting information from the claimant' });
    moved = true;
  }
  return { ok: true, note, moved };
}

/** Supervisor routing override (POST /claims/{id}/routing). The reason is mandatory. */
export function overrideRouting(api, claimId, { queue, adjusterId, reason }) {
  return api.post(`/claims/${encodeURIComponent(claimId)}/routing`, {
    override: { reason: String(reason).trim(), ...(queue ? { queue } : {}), ...(adjusterId ? { adjusterId } : {}) },
  });
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

/**
 * Fallback only (feeds older than S6-BUG-03): the inbox feed now carries insuredName, so app.js no longer calls this.
 * Insured names for inbox rows when the feed carries no party data: read each claim's parties
 * (GET /claims/{id}?include=parties) with bounded concurrency. Failures leave the name blank.
 * `onName(claimId, name)` fires as each one lands so the table can fill in progressively.
 * @returns {Promise<Record<string,string>>}
 */
export async function loadInsureds(api, claimIds, { onName, concurrency = 6 } = {}) {
  const out = {};
  const queue = [...new Set(claimIds)];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        const claim = await api.get(`/claims/${encodeURIComponent(id)}`, { include: 'parties' });
        const name = insuredName(claim);
        if (name) { out[id] = name; onName?.(id, name); }
      } catch { /* a missing name never blocks the inbox */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}
