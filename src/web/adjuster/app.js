// Adjuster app browser wiring. Imports the shared kit; all markup comes from render.js.
import '/shared/components/index.js';
import { createApiClient } from '/shared/api.js';
import { devLogin, isDevMode } from '/shared/devlogin.js';
import { t, registerStrings, setLocale } from '/shared/i18n.js';
import { registerAdjusterStrings } from './strings.js';
import { inboxHtml, claimViewHtml, timerState, formatDuration } from './render.js';
import { loadInbox, loadView, submitDecision, addNote, loadChecklist, saveChecklist } from './actions.js';

registerAdjusterStrings(registerStrings);
const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
if (qs.get('lang')) setLocale(qs.get('lang'));

let token = null;
try { token = sessionStorage.getItem('adjuster.token'); } catch { /* storage may be blocked */ }
const api = createApiClient({ baseUrl: '/api/v1', getToken: () => token });
const toast = (m, kind = 'info') => $('toast').show(m, { kind });

let view = null;
let retryFn = null;

function labelStatic() {
  document.title = t('adj.title');
  const set = (id, key) => { $(id).textContent = t(key); };
  set('title', 'adj.title'); set('skip', 'adj.skip'); set('dev-h', 'adj.dev.heading'); set('dev-tenant-l', 'adj.dev.tenant');
  set('dev-role-l', 'adj.dev.role'); set('dev-go', 'adj.dev.go'); set('un-title', 'adj.unavailable.title'); set('un-retry', 'adj.unavailable.retry');
  set('inbox-h', 'adj.inbox.heading'); set('inbox-mine-l', 'adj.inbox.mine'); set('inbox-refresh', 'adj.inbox.refresh');
  set('lookup-l', 'adj.inbox.lookup'); set('lookup-go', 'adj.inbox.open'); set('claim-back', 'adj.claim.back');
}

function showUnavailable(fn) {
  retryFn = fn; $('un-body').textContent = t('adj.unavailable.body'); $('unavailable').hidden = false; $('un-retry').focus();
}
function hideUnavailable() { $('unavailable').hidden = true; retryFn = null; }
$('un-retry').addEventListener('click', () => { const f = retryFn; hideUnavailable(); f?.(); });

/** Run an API call; map auth failures to the sign-in panel and everything else to the unavailable panel. */
async function guarded(fn, retry) {
  try { hideUnavailable(); return await fn(); } catch (e) {
    if (e.status === 401) { token = null; try { sessionStorage.removeItem('adjuster.token'); } catch { /* ignore */ } route(); return undefined; }
    if (e.status === 404 && e.code === 'not_found') throw e;
    if (e.code === 'service_unavailable' || !e.status) showUnavailable(retry); else toast(e.message || t('adj.error.generic'), 'error');
    return undefined;
  }
}

// ---- inbox
async function showInbox() {
  $('claim-sec').hidden = true; $('inbox-sec').hidden = false; view = null;
  const res = await guarded(() => loadInbox(api, { mine: $('inbox-mine').checked }), showInbox);
  if (!res) return;
  $('inbox-count').textContent = t('adj.inbox.count', { count: res.items.length });
  $('inbox-body').innerHTML = inboxHtml(res.items);
  $('inbox-h').focus();
}
$('inbox-refresh').addEventListener('click', showInbox);
$('inbox-mine').addEventListener('change', showInbox);
$('lookup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('lookup-id').value.trim();
  if (id) location.hash = `#/claim/${encodeURIComponent(id)}`;
});

// ---- claim
function paint() {
  if (!view) return;
  const id = view.claim.id;
  $('claim-body').innerHTML = claimViewHtml(view, { done: loadChecklist(id) });
}
async function showClaim(id) {
  $('inbox-sec').hidden = true; $('claim-sec').hidden = false;
  $('claim-body').textContent = t('adj.claim.loading');
  try {
    const v = await guarded(() => loadView(api, id), () => showClaim(id));
    if (!v) return;
    view = v; paint(); $('claim-h')?.focus();
  } catch (e) {
    $('claim-body').textContent = t('adj.claim.notFound');
  }
}

$('claim-body').addEventListener('change', (e) => {
  const box = e.target.closest?.('input[data-code]');
  if (!box || !view) return;
  const codes = [...$('claim-body').querySelectorAll('input[data-code]:checked')].map((x) => x.dataset.code);
  saveChecklist(view.claim.id, codes);
  const total = $('claim-body').querySelectorAll('input[data-code]').length;
  $('nba-progress').textContent = t('adj.nba.progress', { done: codes.length, total });
});

$('claim-body').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  if (!view) return;
  const claimId = view.claim.id;
  if (form.classList.contains('note-form')) {
    const body = form.elements.body.value.trim();
    if (!body) return;
    const ok = await guarded(() => addNote(api, claimId, body), () => {});
    if (ok) { toast(t('adj.notes.saved'), 'success'); await refreshView(); }
    return;
  }
  if (!form.classList.contains('decision')) return;
  const action = e.submitter?.dataset.action;
  const err = form.querySelector('.err');
  const note = form.elements.note.value;
  if (!note.trim()) { err.textContent = t('adj.decision.noteRequired'); err.hidden = false; form.elements.note.focus(); return; }
  err.hidden = true;
  const res = await guarded(() => submitDecision(api, claimId, { kind: form.dataset.kind, action, note, tasks: view.tasks }), () => {});
  if (res?.ok) { toast(t('adj.decision.saved'), 'success'); await refreshView(); }
});

async function refreshView() {
  const id = view.claim.id;
  const v = await guarded(() => loadView(api, id), () => {});
  if (v) { view = v; paint(); }
}

// ---- live timers: recompute chip text each 30s without refetching
function tick() {
  for (const el of document.querySelectorAll('[data-chip="timer"][data-due]')) {
    const st = timerState({ status: 'running', dueAt: el.dataset.due });
    const kind = el.dataset.kind;
    el.textContent = st.state === 'overdue' ? t('adj.timer.overdue', { kind, left: formatDuration(st.ms) }) : t('adj.timer.left', { kind, left: formatDuration(st.ms) });
  }
}
setInterval(tick, 30000);

// ---- auth + routing
$('dev-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await devLogin(api, { tenant: $('dev-tenant').value, role: $('dev-role').value });
    token = res.token;
    try { sessionStorage.setItem('adjuster.token', token); } catch { /* ignore */ }
    $('whoami').textContent = t('adj.dev.role') + ': ' + $('dev-role').value;
    route();
  } catch (err) { toast(err.message || t('adj.error.generic'), 'error'); }
});

function route() {
  if (!token) {
    $('inbox-sec').hidden = true; $('claim-sec').hidden = true;
    $('dev-panel').hidden = !isDevMode();
    return;
  }
  $('dev-panel').hidden = true;
  const m = /^#\/claim\/(.+)$/.exec(location.hash);
  if (m) showClaim(decodeURIComponent(m[1])); else showInbox();
}
window.addEventListener('hashchange', route);

labelStatic();
route();
