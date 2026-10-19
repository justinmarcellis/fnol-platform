// Carrier admin console wiring. Pure logic lives in config-model.js, edit.js, client.js and render.js.
import '/shared/components/index.js';
import '/shared/components/demo-bar.js';
import { isDevMode } from '/shared/devlogin.js';
import { applyBranding } from '/shared/theme.js';
import { clearSession, readSession } from '/shared/personas.js';
import { createAdminClient } from './client.js';
import { changedSections, clone, diffConfig, isDirty, parsePointer, parseCsv } from './config-model.js';
import { applyFieldEdit, applyListAction } from './edit.js';
import { SECTION_LABEL, TABS, diffHtml, markHtml, panelHtml, summaryHtml, tabsHtml } from './render.js';

const $ = (id) => document.getElementById(id);
const toast = (m, kind = 'info') => $('toast').show(m, { kind });

let token = null;
try { token = sessionStorage.getItem('admin.token'); } catch { /* storage may be blocked */ }
const client = createAdminClient({ baseUrl: '/api/v1', getToken: () => token });

const state = {
  cfg: null, saved: null, version: 0, tab: 'branding', qSet: 0, report: null, localErrors: {}, rawText: {},
  webhooks: null, history: null, kpis: null, who: '',
};

function ctx() { return { ...state }; }

/** True when the persona switcher is mounted (dev servers); the old dev form is then never shown. */
const demoBarPresent = () => globalThis.__FNOL_DEV__ === true;

function renderPanel() {
  $('panel').innerHTML = panelHtml(state.tab, ctx());
  $('summary').innerHTML = summaryHtml(state.report);
  paintStatus();
}

/** Section id -> number of changed fields, from the diff against the saved config. */
function changeCounts() {
  const out = {};
  for (const c of diffConfig(state.saved, state.cfg)) out[c.section] = (out[c.section] ?? 0) + 1;
  return out;
}

function paintStatus() {
  $('version-label').textContent = `Version ${state.version}`;
  const dirty = isDirty(state.saved, state.cfg);
  const counts = changeCounts();
  const names = [...new Set(Object.keys(counts).map((k) => SECTION_LABEL[k] ?? 'Other'))];
  $('dirty-label').textContent = dirty ? `Unsaved changes${names.length ? `: ${names.join(', ')}` : ''}` : 'No unsaved changes';
  $('savebar').dataset.dirty = String(dirty);
  $('revert').disabled = !dirty;
  paintNav(counts);
  const shell = $('shell');
  if (state.cfg) shell.setAttribute('tenant-name', state.cfg.displayName ?? state.cfg.tenantId ?? '');
}

/** Update the nav in place so a link is never replaced between mouse-down and click. */
function paintNav(counts) {
  const nav = $('tabs');
  if (nav.dataset.active !== state.tab || !nav.children.length) { nav.innerHTML = tabsHtml(state.tab, state.report, counts); nav.dataset.active = state.tab; return; }
  for (const [id] of TABS) {
    const mark = nav.querySelector(`#tab-${id} .adm-mark`);
    const html = markHtml(state.report?.bySection?.[id] ?? 0, counts[id] ?? 0);
    if (mark && mark.innerHTML !== html) mark.innerHTML = html;
  }
}

function showOnly(...ids) { for (const s of ['dev-panel', 'no-login', 'pick-persona', 'unavailable', 'console', 'conflict']) $(s).hidden = !ids.includes(s); }

let retryFn = null;
async function guarded(fn, retry) {
  try { return await fn(); } catch (e) {
    if (e.status === 401 || e.status === 403) { signOut(); toast('Your session ended. Sign in again.', 'error'); return undefined; }
    if (retry && (e.code === 'service_unavailable' || !e.status)) { retryFn = retry; showOnly('unavailable'); $('un-retry').focus(); } else toast(e.message || 'Something went wrong.', 'error');
    return undefined;
  }
}
$('un-retry').addEventListener('click', () => { const f = retryFn; retryFn = null; f?.(); });

// ---- sign in / out
function signOut() {
  token = null; state.cfg = null;
  try { sessionStorage.removeItem('admin.token'); sessionStorage.removeItem('admin.who'); clearSession(sessionStorage); } catch { /* ignore */ }
  boot();
}
$('shell').addEventListener('fx-signout', signOut);
$('dev-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tenant = $('dev-tenant').value;
  const t = await guarded(() => client.devLogin({ tenant }), null);
  if (!t) return;
  token = t; state.who = `${tenant} tenant admin`;
  try { sessionStorage.setItem('admin.token', t); sessionStorage.setItem('admin.who', state.who); } catch { /* ignore */ }
  boot();
});

// ---- load
async function loadAll() {
  const res = await guarded(() => client.loadConfig(), loadAll);
  if (!res) return;
  state.cfg = clone(res.config); state.saved = clone(res.config); state.version = res.version;
  state.report = null; state.localErrors = {}; state.rawText = {};
  state.webhooks = null; state.history = null; state.kpis = null;
  $('conflict').hidden = true;
  try { applyBranding(res.config); } catch { /* branding is cosmetic */ }
  showOnly('console');
  setUser();
  renderPanel();
  loadTabData();
}

async function loadTabData() {
  if (state.tab === 'webhooks' && !state.webhooks) {
    state.webhooks = await guarded(() => client.listWebhooks()) ?? { available: false, items: [] };
    if (state.tab === 'webhooks') renderPanel();
  }
  if (state.tab === 'history' && !state.history) {
    state.history = await guarded(() => client.loadHistory()) ?? { available: false, rows: [] };
    if (state.tab === 'history') renderPanel();
  }
  if (state.tab === 'kpis' && !state.kpis) {
    state.kpis = await guarded(() => client.loadKpis()) ?? { available: false, body: null };
    if (state.tab === 'kpis') renderPanel();
  }
}

const TAB_IDS = TABS.map((t) => t[0]);
function selectTab(id) {
  state.tab = id;
  try { history.replaceState(null, '', `#/${id}`); } catch { /* ignore */ }
  renderPanel();
  loadTabData();
}
$('tabs').addEventListener('click', (e) => {
  const a = e.target.closest('[data-tab]');
  if (!a) return;
  e.preventDefault();
  selectTab(a.dataset.tab);
});
function setUser() {
  const shell = $('shell');
  const who = state.who || (state.cfg ? `${state.cfg.tenantId} admin` : '');
  shell.setAttribute('user-name', who.replace(/\s*\(.*\)\s*$/, ''));
  let role = 'tenant_admin';
  try { role = readSession(sessionStorage)?.persona?.role ?? role; } catch { /* ignore */ }
  shell.setAttribute('user-role', role);
}

// ---- field edits
function showFieldError(el, message) {
  const id = el.id;
  let p = document.getElementById(`${id}-err`);
  if (message) {
    if (!p) { p = document.createElement('p'); p.className = 'err'; p.id = `${id}-err`; p.dataset.errorFor = el.dataset.path; el.closest('.field').appendChild(p); }
    p.textContent = message; el.setAttribute('aria-invalid', 'true');
    const d = new Set((el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)); d.add(p.id); el.setAttribute('aria-describedby', [...d].join(' '));
  } else {
    p?.remove(); el.removeAttribute('aria-invalid');
    const d = (el.getAttribute('aria-describedby') ?? '').split(' ').filter((x) => x && x !== `${id}-err`); if (d.length) el.setAttribute('aria-describedby', d.join(' ')); else el.removeAttribute('aria-describedby');
  }
}

function onEdit(e) {
  const el = e.target.closest('[data-path][data-kind]');
  if (!el || el.closest('#wh-form')) return;
  const kind = el.dataset.kind;
  const raw = kind === 'bool' ? el.checked : el.value;
  const { structural } = applyFieldEdit(state, { pointer: el.dataset.path, kind, locale: el.dataset.locale, raw });
  showFieldError(el, state.localErrors[el.dataset.path] ?? null);
  paintStatus();
  if (structural && e.type === 'change') renderPanel();
}
$('panel').addEventListener('input', onEdit);
$('panel').addEventListener('change', (e) => {
  if (e.target.dataset?.ui === 'qset') { state.qSet = Number(e.target.value); renderPanel(); return; }
  onEdit(e);
});

// ---- buttons inside the panel
$('panel').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (['add', 'remove', 'up', 'down'].includes(act)) {
    applyListAction(state, act, b.dataset.path, Number(b.dataset.index ?? 0));
    renderPanel();
    return;
  }
  if (act === 'kpi-refresh') { state.kpis = null; renderPanel(); loadTabData(); return; }
  if (act === 'wh-toggle') {
    await guarded(() => client.setWebhookActive(b.dataset.id, b.dataset.active === 'true'));
    state.webhooks = null; renderPanel(); loadTabData(); return;
  }
  if (act === 'wh-delete') {
    await guarded(() => client.deleteWebhook(b.dataset.id));
    toast('Webhook deleted.'); state.webhooks = null; renderPanel(); loadTabData();
  }
});
$('panel').addEventListener('submit', async (e) => {
  if (e.target.id !== 'wh-form') return;
  e.preventDefault();
  const url = $('wh-url').value.trim();
  const eventTypes = parseCsv($('wh-events').value);
  if (!/^https?:\/\/\S+$/i.test(url)) { $('wh-msg').textContent = 'Enter a full http or https URL.'; $('wh-url').focus(); return; }
  if (!eventTypes.length) { $('wh-msg').textContent = 'Enter at least one event type.'; $('wh-events').focus(); return; }
  const r = await guarded(() => client.createWebhook({ url, eventTypes }));
  if (!r) return;
  if (!r.ok) { $('wh-msg').textContent = r.message; return; }
  toast(r.webhook?.secret ? `Webhook created. Signing secret (shown once): ${r.webhook.secret}` : 'Webhook created.', 'success');
  state.webhooks = null; renderPanel(); loadTabData();
});

// ---- validate / save / revert
function firstProblemFocus() { $('summary').focus(); }

async function runValidate() {
  if (Object.keys(state.localErrors).length) { reportLocal(); return null; }
  const rep = await guarded(() => client.validate(state.cfg));
  if (!rep) return null;
  state.report = rep; renderPanel();
  if (!rep.valid) firstProblemFocus();
  return rep;
}
function reportLocal() {
  const first = Object.keys(state.localErrors)[0];
  toast('Fix the highlighted fields before saving.', 'error');
  renderPanel();
  document.querySelector(`[data-path="${CSS.escape(first)}"]`)?.focus();
}
$('validate').addEventListener('click', async () => { const r = await runValidate(); if (r?.valid) toast('Configuration is valid.', 'success'); });
// Save is two steps: validate, then a diff preview the admin confirms.
$('save').addEventListener('click', async () => {
  if (Object.keys(state.localErrors).length) { reportLocal(); return; }
  const changes = diffConfig(state.saved, state.cfg);
  if (!changes.length) { toast('There are no changes to save.'); return; }
  const rep = await runValidate();
  if (!rep?.valid) return;
  $('diff-sub').textContent = `${changes.length} change${changes.length === 1 ? '' : 's'} across ${new Set(changes.map((c) => c.section)).size} section(s). Saving creates version ${state.version + 1}.`;
  $('diff-body').innerHTML = diffHtml(changes);
  $('diff').showModal();
  $('diff-confirm').focus();
});
$('diff-cancel').addEventListener('click', () => $('diff').close());
$('diff-confirm').addEventListener('click', async () => {
  const btn = $('diff-confirm');
  btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
  let res;
  try { res = await guarded(() => client.save(state.cfg, state.version)); } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
  $('diff').close();
  if (!res) return;
  if (res.outcome === 'invalid') { state.report = res.report; renderPanel(); firstProblemFocus(); return; }
  if (res.outcome === 'conflict') { $('conflict-body').textContent = `${res.message} Reload to see the latest version, then re-apply your edits.`; showConflict(); return; }
  state.cfg = clone(res.config); state.saved = clone(res.config); state.version = res.version;
  state.report = { valid: true, errors: [], warnings: [], bySection: {} };
  state.history = null;
  try { applyBranding(res.config); } catch { /* cosmetic */ }
  renderPanel();
  toast(`Saved as version ${res.version}.`, 'success');
  if (state.tab === 'history') loadTabData();
});
function showConflict() { $('conflict').hidden = false; $('conflict').scrollIntoView?.({ block: 'nearest' }); $('conflict-reload').focus(); }
$('revert').addEventListener('click', () => { state.cfg = clone(state.saved); state.report = null; state.localErrors = {}; state.rawText = {}; renderPanel(); });
$('conflict-reload').addEventListener('click', loadAll);

// Jump from an error summary link to the field.
$('summary').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-goto]');
  if (!a) return;
  e.preventDefault();
  const segs = parsePointer(a.dataset.goto);
  if (segs[0] === 'questionSets' && /^\d+$/.test(segs[1] ?? '')) state.qSet = Number(segs[1]);
  state.tab = TAB_IDS.includes(a.dataset.section) ? a.dataset.section : 'branding';
  renderPanel();
  for (let n = segs.length; n > 0; n--) {
    const ptr = `/${segs.slice(0, n).join('/')}`;
    const el = document.querySelector(`[data-path="${CSS.escape(ptr)}"]`);
    if (el) { el.focus(); return; }
  }
});

function boot() {
  const fromHash = location.hash.replace(/^#\//, '');
  if (TAB_IDS.includes(fromHash)) state.tab = fromHash;
  $('shell').toggleAttribute('no-signout', !token);
  if (!token) { $('shell').removeAttribute('user-name'); $('shell').removeAttribute('user-role'); }
  if (token) { try { state.who = sessionStorage.getItem('admin.who') ?? ''; } catch { /* ignore */ } loadAll(); return; }
  // With the demo bar present the old developer form is gone; the bar signs the persona in.
  showOnly(demoBarPresent() ? 'pick-persona' : isDevMode() ? 'dev-panel' : 'no-login');
}
window.addEventListener('beforeunload', (e) => { if (state.cfg && isDirty(state.saved, state.cfg)) { e.preventDefault(); } });
boot();
