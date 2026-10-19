// Adjuster workbench browser wiring. Imports the shared kit; markup for the claim view comes from render.js,
// the inbox view-model from model.js, table columns from inbox.js.
import '/shared/components/index.js';
import '/shared/components/demo-bar.js';
import { createApiClient } from '/shared/api.js';
import { devLogin, isDevMode } from '/shared/devlogin.js';
import { t, registerStrings, setLocale } from '/shared/i18n.js';
import { applyBranding } from '/shared/theme.js';
import { consumePersonaToken, readSession, clearSession } from '/shared/personas.js';
import { registerAdjusterStrings } from './strings.js';
import { claimViewHtml, claimHeading, claimSubheading, formatDuration } from './render.js';
import { inboxRows, inboxKpis, filterRows, statusOptions, timerUrgency, defaultScope, SEVERITY_BANDS } from './model.js';
import { inboxColumns, renderKpis } from './inbox.js';
import { loadInbox, loadView, loadDirectory, submitDecision, addNote, changeStatus, updateTask, requestInfo, overrideRouting, loadChecklist, saveChecklist } from './actions.js';
import { formatEnum } from '/shared/format.js';

registerAdjusterStrings(registerStrings);
const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
if (qs.get('lang')) setLocale(qs.get('lang'));

const barPresent = () => globalThis.__FNOL_DEV__ === true; // <fx-demo-bar> renders only when the server runs in dev mode
const shell = $('shell');

let token = null;
try {
  token = sessionStorage.getItem('adjuster.token') ?? consumePersonaToken('/adjuster')?.token ?? null;
} catch { /* storage may be blocked */ }
const api = createApiClient({ baseUrl: '/api/v1', getToken: () => token });
const toast = (m, kind = 'info') => $('toast').show(m, { kind });

let view = null;
let retryFn = null;
const inbox = { items: [], insureds: {}, filters: { scope: 'mine', status: 'all', severity: 'all' }, table: null, loaded: false, scopeFor: null };
/** Signed-in user: role drives the landing scope and the supervisor controls; dir resolves ids to names. */
const me = { role: 'adjuster', sub: '', tenant: null, dir: { people: {}, queues: [], rules: {} }, dirLoaded: false };

// ---- inbox scope: supervisors land on the team queue, adjusters on their own claims. The choice is kept
// per signed-in user for the tab, so Refresh, Back and reload keep it.
const scopeKey = () => `adjuster.scope:${me.tenant ?? ''}:${me.sub}`;
function initScope() {
  const who = scopeKey();
  if (inbox.scopeFor === who) return;
  inbox.scopeFor = who;
  let saved = null;
  try { saved = sessionStorage.getItem(who); } catch { /* storage may be blocked */ }
  inbox.filters.scope = saved === 'mine' || saved === 'all' ? saved : defaultScope(me.role);
}
function setScope(scope) {
  inbox.filters.scope = scope;
  try { sessionStorage.setItem(scopeKey(), scope); } catch { /* ignore */ }
}

// ---- identity and chrome
function claimsOfToken(tok) {
  try { return JSON.parse(atob(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; }
}
function identify() {
  const s = readSession();
  const who = s?.persona?.app === '/adjuster' ? { name: s.persona.displayName, role: s.persona.role, tenant: s.tenantId } : null;
  const c = claimsOfToken(token);
  const name = who?.name ?? c.name ?? c.displayName ?? c.sub ?? '';
  const roles = c.roles ?? [];
  const role = who?.role ?? (roles.includes('supervisor') ? 'supervisor' : roles[0]) ?? 'adjuster';
  shell.setAttribute('user-name', token ? String(name) : '');
  shell.setAttribute('user-role', role);
  me.role = role === 'supervisor' ? 'supervisor' : 'adjuster';
  me.sub = String(c.sub ?? '');
  me.tenant = who?.tenant ?? c.tenantId ?? c.tid ?? null;
  return me.tenant;
}
async function brand() {
  try {
    const cfg = await api.get('/config/public');
    applyBranding(cfg);
    if (cfg?.displayName) shell.setAttribute('tenant-name', cfg.displayName);
  } catch { /* branding is optional */ }
}
function setPage(heading, subheading = '') {
  shell.setAttribute('heading', heading);
  shell.setAttribute('subheading', subheading);
  document.title = `${heading} · ${t('adj.title')}`;
}
function setNav(current) {
  shell.navItems = [{ href: '#/', label: t('adj.nav.inbox'), icon: 'inbox', current }];
}

function labelStatic() {
  const set = (id, key) => { const n = $(id); if (n) n.textContent = t(key); };
  set('skip', 'adj.skip'); set('un-title', 'adj.unavailable.title'); set('un-retry', 'adj.unavailable.retry');
  set('inbox-h', 'adj.inbox.heading'); set('inbox-refresh', 'adj.inbox.refresh'); set('claim-back', 'adj.claim.back');
  set('f-scope-l', 'adj.filter.scope'); set('f-status-l', 'adj.filter.status'); set('f-severity-l', 'adj.filter.severity'); set('filters-clear', 'adj.filter.clear');
  const scope = $('inbox-scope'); scope.options[0].textContent = t('adj.filter.mine'); scope.options[1].textContent = t('adj.filter.all');
  $('filters').setAttribute('aria-label', t('adj.filter.label'));
  shell.setAttribute('product', t('adj.product')); shell.setAttribute('nav-label', t('adj.nav.label'));
  fillSelect($('inbox-severity'), SEVERITY_BANDS.map((b) => [b, formatEnum(b)]), inbox.filters.severity);
  fillSelect($('inbox-status'), [], inbox.filters.status);
}
function fillSelect(sel, pairs, current) {
  sel.textContent = '';
  for (const [v, label] of [['all', t('adj.filter.any')], ...pairs]) {
    const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o);
  }
  sel.value = pairs.some(([v]) => v === current) ? current : 'all';
}

function showUnavailable(fn) {
  retryFn = fn; $('un-body').textContent = t('adj.unavailable.body'); $('unavailable').hidden = false; $('un-retry').focus();
}
function hideUnavailable() { $('unavailable').hidden = true; retryFn = null; }
$('un-retry').addEventListener('click', () => { const f = retryFn; hideUnavailable(); f?.(); });

/** Run an API call; map auth failures to the sign-in state and everything else to the unavailable alert. */
async function guarded(fn, retry) {
  try { hideUnavailable(); return await fn(); } catch (e) {
    if (e.status === 401) { signOut(false); return undefined; }
    if (e.status === 404 && e.code === 'not_found') throw e;
    if (e.code === 'service_unavailable' || !e.status) showUnavailable(retry); else toast(e.message || t('adj.error.generic'), 'error');
    return undefined;
  }
}

// ---- inbox
function paintInbox() {
  const rows = inboxRows(inbox.items, { insureds: inbox.insureds });
  renderKpis($('kpis'), inboxKpis(rows));
  const opts = statusOptions(rows).map((s) => [s, formatEnum(s)]);
  fillSelect($('inbox-status'), opts, inbox.filters.status);
  inbox.filters.status = $('inbox-status').value;
  const shown = filterRows(rows, inbox.filters);
  const filtered = inbox.filters.status !== 'all' || inbox.filters.severity !== 'all';
  $('filters-clear').hidden = !filtered;
  $('inbox-count').textContent = filtered ? t('adj.inbox.shown', { shown: shown.length, total: rows.length }) : t('adj.inbox.count', { count: rows.length });
  const body = $('inbox-body');
  if (!rows.length || !shown.length) {
    inbox.table = null;
    body.textContent = '';
    const es = document.createElement('fx-empty-state');
    es.id = 'inbox-empty';
    es.setAttribute('icon', rows.length ? 'filter' : 'inbox');
    es.setAttribute('heading', t(rows.length ? 'adj.inbox.nomatch.heading' : 'adj.inbox.empty.heading'));
    es.setAttribute('description', t(rows.length ? 'adj.inbox.nomatch.body' : 'adj.inbox.empty.body'));
    const action = document.createElement('button');
    action.type = 'button'; action.className = 'fx-btn secondary';
    if (rows.length) { action.textContent = t('adj.filter.clear'); action.addEventListener('click', clearFilters); es.appendChild(action); }
    else if (inbox.filters.scope === 'mine') { action.textContent = t('adj.inbox.empty.all'); action.addEventListener('click', () => { $('inbox-scope').value = 'all'; setScope('all'); showInbox(); }); es.appendChild(action); }
    body.appendChild(es);
    return;
  }
  if (!inbox.table?.isConnected) {
    body.textContent = '';
    const hint = document.createElement('p');
    hint.className = 'adj-scroll-hint'; hint.id = 'inbox-scroll-hint'; hint.textContent = t('adj.inbox.scroll');
    body.appendChild(hint);
    inbox.table = document.createElement('fx-table');
    inbox.table.id = 'inbox-table';
    inbox.table.setAttribute('caption', t('adj.inbox.table'));
    inbox.table.columns = inboxColumns();
    inbox.table.addEventListener('fx-select', (e) => { location.hash = `#/claim/${encodeURIComponent(e.detail.row.claimId)}`; });
    body.appendChild(inbox.table);
    // Keep a data-claim-id hook on each row (fx-table owns the <tr>s, so mirror it from the claim link after every render/sort).
    const tagRows = () => inbox.table.querySelectorAll('tbody tr').forEach((tr) => {
      const id = tr.querySelector('a[data-claim-id]')?.getAttribute('data-claim-id');
      if (id && tr.getAttribute('data-claim-id') !== id) tr.setAttribute('data-claim-id', id);
    });
    new MutationObserver(tagRows).observe(inbox.table, { childList: true, subtree: true });
    inbox.tagRows = tagRows;
  }
  inbox.table.rows = shown;
  inbox.tagRows?.();
}

function clearFilters() {
  inbox.filters.status = 'all'; inbox.filters.severity = 'all';
  $('inbox-severity').value = 'all'; $('inbox-status').value = 'all';
  paintInbox();
}

async function showInbox() {
  $('claim-sec').hidden = true; $('signin').hidden = true; $('inbox-sec').hidden = false; view = null;
  $('inbox-refresh').hidden = false; $('claim-back').hidden = true;
  setNav(true); setPage(t('adj.inbox.heading'), t('adj.inbox.subheading'));
  initScope();
  $('inbox-scope').value = inbox.filters.scope;
  if (!inbox.loaded) { $('inbox-body').textContent = ''; const sk = document.createElement('fx-skeleton'); sk.setAttribute('variant', 'table'); sk.setAttribute('rows', '6'); sk.setAttribute('label', t('adj.inbox.loading')); $('inbox-body').appendChild(sk); }
  const res = await guarded(() => loadInbox(api, { mine: inbox.filters.scope === 'mine' }), showInbox);
  if (!res) return;
  // The feed carries insuredName, assignedAt and fastTrack, so the table paints complete in one request.
  inbox.items = res.items; inbox.loaded = true;
  paintInbox();
  $('inbox-h').focus();
}
$('inbox-refresh').addEventListener('click', showInbox);
$('inbox-scope').addEventListener('change', (e) => { setScope(e.target.value); showInbox(); });
$('inbox-status').addEventListener('change', (e) => { inbox.filters.status = e.target.value; paintInbox(); });
$('inbox-severity').addEventListener('change', (e) => { inbox.filters.severity = e.target.value; paintInbox(); });
$('filters-clear').addEventListener('click', clearFilters);
$('filters').addEventListener('submit', (e) => e.preventDefault());

// ---- claim
function paint() {
  if (!view) return;
  const id = view.claim.id;
  $('claim-body').innerHTML = claimViewHtml(view, { done: loadChecklist(id), dir: me.dir, role: me.role });
  for (const tl of $('claim-body').querySelectorAll('fx-timeline[data-events]')) {
    try { tl.events = JSON.parse(tl.dataset.events); } catch { tl.events = []; }
  }
  setPage(claimHeading(view), claimSubheading(view));
}
async function showClaim(id) {
  $('inbox-sec').hidden = true; $('signin').hidden = true; $('claim-sec').hidden = false;
  $('inbox-refresh').hidden = true; $('claim-back').hidden = false;
  setNav(false); setPage(t('adj.claim.loading'));
  $('claim-body').textContent = '';
  const sk = document.createElement('fx-skeleton'); sk.setAttribute('variant', 'card'); sk.setAttribute('lines', '4'); sk.setAttribute('label', t('adj.claim.loading'));
  $('claim-body').appendChild(sk);
  try {
    await ensureDirectory();
    const v = await guarded(() => loadView(api, id), () => showClaim(id));
    if (!v) return;
    view = v; paint(); $('claim-h').textContent = claimHeading(v); $('claim-h').focus();
  } catch (e) {
    $('claim-body').textContent = '';
    const es = document.createElement('fx-empty-state');
    es.setAttribute('icon', 'search'); es.setAttribute('heading', t('adj.claim.notFound'));
    $('claim-body').appendChild(es);
    setPage(t('adj.claim.notFound'));
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

/** Status moves and task buttons. */
$('claim-body').addEventListener('click', async (e) => {
  if (!view) return;
  const claimId = view.claim.id;
  const move = e.target.closest?.('[data-status-to]');
  if (move) {
    const to = move.dataset.statusTo;
    move.disabled = true;
    const ok = await guarded(() => changeStatus(api, claimId, { to }), () => {});
    move.disabled = false;
    if (ok) { toast(t('adj.actions.saved', { status: formatEnum(to) }), 'success'); await refreshView(); }
    return;
  }
  const task = e.target.closest?.('[data-task-id][data-task-status]');
  if (task) {
    task.disabled = true;
    const ok = await guarded(() => updateTask(api, claimId, task.dataset.taskId, task.dataset.taskStatus), () => {});
    task.disabled = false;
    if (ok) { toast(t('adj.tasks.saved'), 'success'); await refreshView(); }
  }
});

/** Override form: picking an adjuster selects their queue. */
$('claim-body').addEventListener('change', (e) => {
  if (e.target.id !== 'override-adjuster') return;
  const q = e.target.selectedOptions[0]?.dataset.queue;
  if (q) $('override-queue').value = q;
});

/** Load the name directory once per sign-in (never blocks the view; ids show if it fails). */
async function ensureDirectory() {
  if (me.dirLoaded) return;
  me.dir = await loadDirectory(api);
  me.dirLoaded = true;
}

/** "Go to" buttons: scroll to the panel or item where the action is done. */
$('claim-body').addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-goto]');
  if (!btn) return;
  const target = document.getElementById(btn.dataset.goto);
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  const focusable = target.querySelector('textarea, button, input, a[href]') ?? target;
  if (!focusable.hasAttribute('tabindex') && focusable === target) target.setAttribute('tabindex', '-1');
  focusable.focus({ preventScroll: true });
});

$('claim-body').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  if (!view) return;
  const claimId = view.claim.id;
  const err = form.querySelector('.err');
  const fail = (key, field) => { if (err) { err.textContent = t(key); err.hidden = false; } field?.focus(); };
  if (err) err.hidden = true;
  if (form.classList.contains('note-form')) {
    const body = form.elements.body.value.trim();
    if (!body) { fail('adj.notes.empty', form.elements.body); return; }
    const ok = await guarded(() => addNote(api, claimId, body), () => {});
    if (ok) { toast(t('adj.notes.saved'), 'success'); await refreshView(); }
    return;
  }
  if (form.classList.contains('close-form')) {
    const closeReason = form.elements.closeReason.value;
    if (!closeReason) { fail('adj.actions.closeReasonRequired', form.elements.closeReason); return; }
    const ok = await guarded(() => changeStatus(api, claimId, { to: 'closed', closeReason }), () => {});
    if (ok) { toast(t('adj.actions.saved', { status: formatEnum('closed') }), 'success'); await refreshView(); }
    return;
  }
  if (form.classList.contains('request-form')) {
    const kind = form.elements.kind.value;
    const message = form.elements.message.value.trim();
    const body = [t('adj.request.body', { kind: t(`adj.request.kind.${kind}`) }), message].filter(Boolean).join(' ');
    const ok = await guarded(() => requestInfo(api, claimId, { body, status: view.claim.status }), () => {});
    if (ok) { toast(t('adj.request.saved'), 'success'); await refreshView(); }
    return;
  }
  if (form.classList.contains('override-form')) {
    const reason = form.elements.reason.value.trim();
    if (!reason) { fail('adj.override.reasonRequired', form.elements.reason); return; }
    const adjSel = form.elements.adjusterId;
    const adjusterId = adjSel.value;
    const queue = adjusterId ? adjSel.selectedOptions[0]?.dataset.queue ?? form.elements.queue.value : form.elements.queue.value;
    const ok = await guarded(() => overrideRouting(api, claimId, { queue, adjusterId, reason }), () => {});
    if (ok) { toast(t('adj.override.saved'), 'success'); await refreshView(); }
    return;
  }
  if (!form.classList.contains('decision')) return;
  const action = e.submitter?.dataset.action;
  const note = form.elements.note.value;
  if (!note.trim()) { fail('adj.decision.noteRequired', form.elements.note); return; }
  const res = await guarded(() => submitDecision(api, claimId, { kind: form.dataset.kind, action, note, tasks: view.tasks }), () => {});
  if (res?.ok) { toast(t('adj.decision.saved'), 'success'); await refreshView(); }
});

async function refreshView() {
  const id = view.claim.id;
  const v = await guarded(() => loadView(api, id), () => {});
  if (v) { view = v; paint(); }
}

// ---- live timers: recompute badge text and tone every 30 s without refetching
function tick() {
  for (const el of document.querySelectorAll('fx-badge[data-chip="timer"][data-due]')) {
    const u = timerUrgency({ status: 'running', dueAt: el.dataset.due });
    const left = formatDuration(u.ms);
    el.setAttribute('label', u.state === 'overdue' ? t('adj.timer.overdue', { kind: el.dataset.kind, left }) : t('adj.timer.left', { kind: el.dataset.kind, left }));
    el.setAttribute('tone', u.tone);
    el.dataset.state = u.state;
  }
}
setInterval(tick, 30000);

// ---- auth + routing
function signOut(clear = true) {
  token = null;
  try { sessionStorage.removeItem('adjuster.token'); if (clear) clearSession(); } catch { /* ignore */ }
  inbox.loaded = false; inbox.items = []; inbox.insureds = {}; inbox.scopeFor = null;
  me.dirLoaded = false; me.dir = { people: {}, queues: [], rules: {} };
  route();
}
shell.addEventListener('fx-signout', () => signOut(true));

$('dev-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await devLogin(api, { tenant: $('dev-tenant').value, role: $('dev-role').value });
    token = res.token;
    try { sessionStorage.setItem('adjuster.token', token); } catch { /* ignore */ }
    route();
  } catch (err) { toast(err.message || t('adj.error.generic'), 'error'); }
});

function showSignedOut() {
  $('inbox-sec').hidden = true; $('claim-sec').hidden = true;
  $('inbox-refresh').hidden = true; $('claim-back').hidden = true;
  setNav(false); setPage(t('adj.title'));
  identify();
  const bar = barPresent();
  // The legacy form is for hosts without the demo bar; with the bar present it is removed, not just hidden.
  const panel = $('dev-panel');
  if (bar) panel?.remove(); else if (panel) panel.hidden = !isDevMode();
  const es = document.createElement('fx-empty-state');
  es.id = 'signin-empty';
  es.setAttribute('icon', 'user');
  es.setAttribute('heading', t(bar ? 'adj.signin.heading' : 'adj.signin.plain.heading'));
  es.setAttribute('description', t(bar ? 'adj.signin.body' : 'adj.signin.plain.body'));
  const card = document.createElement('fx-card');
  card.setAttribute('padding', 'none');
  card.appendChild(es);
  $('signin').replaceChildren(card);
  $('signin').hidden = false;
}

let branded = false;
function route() {
  if (!token) { showSignedOut(); return; }
  $('dev-panel')?.setAttribute('hidden', '');
  identify();
  if (!branded) { branded = true; brand(); }
  const m = /^#\/claim\/(.+)$/.exec(location.hash);
  if (m) showClaim(decodeURIComponent(m[1])); else showInbox();
}
window.addEventListener('hashchange', route);

labelStatic();
route();
