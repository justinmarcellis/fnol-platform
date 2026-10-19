// CSR portal browser wiring. The only file (with view.js) that imports the shared kit.
import '/shared/components/index.js';
import { createApiClient } from '/shared/api.js';
import { isDevMode } from '/shared/devlogin.js';
import '/shared/components/demo-bar.js';
import { readSession, clearSession } from '/shared/personas.js';
import { formatEnum, formatDate, formatMoney, formatRelative, formatDateTime, formatClaimNumber, formatPolicyNumber } from '/shared/format.js';
import { t, registerStrings, setLocale, resolveText } from '/shared/i18n.js';
import { applyBranding } from '/shared/theme.js';
import { registerCsrStrings } from './strings.js';
import { createPolicySearch } from './search.js';
import { createAssistedIntake, claimLink } from './assisted.js';
import { isDisclosure, fieldType, coerceAnswer, disclosureAccepted, isStructured, structuredFields, buildStructured, missingStructured, errorFor, fetchPolicyVehicles, isMultiSelect, fieldRules } from './answers.js';
import { renderMissing } from './panel.js';
import { createRecent, recentColumns, claimSummary } from './recent.js';
import { deskRole, deskAccess, channelFor, roleKeys, policyExamples } from './roles.js';
import { policyTone } from './desk.js';
import { isoDate } from './errors.js';
import { contextModel, progressModel } from './desk.js';

registerCsrStrings(registerStrings);
const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
let token = null;
try { token = sessionStorage.getItem('csr.token'); } catch { /* storage may be blocked */ }
// CSR or agent (the demo persona, else the token's roles): labels, intake channel and which reads the server allows.
const role = deskRole(readSession(), token);
const access = deskAccess(role);

const base = createApiClient({ baseUrl: '/api/v1', getToken: () => token });
// The shared client's post() has no headers option; build a one-off client when headers are needed.
// The shared client drops the body of a 422; the intake step (with per-question errors[]) is kept here so the
// structured sub-form can show the server's message inline. It is attached to the thrown error as `errors`.
let last422 = null;
const clientFor = (extra) => createApiClient({
  baseUrl: '/api/v1', getToken: () => token,
  fetchImpl: async (url, init) => {
    const res = await fetch(url, extra ? { ...init, headers: { ...init.headers, ...extra } } : init);
    if (res.status === 422) { try { last422 = await res.clone().json(); } catch { last422 = null; } }
    return res;
  },
});
const base422 = clientFor(null);
async function withErrors(fn) {
  last422 = null;
  try { return await fn(); } catch (err) {
    if (err?.status === 422 && Array.isArray(last422?.errors)) err.errors = last422.errors;
    throw err;
  }
}
const api = {
  get: (p, q) => base.get(p, q),
  post: (p, b, o) => withErrors(() => (o?.headers ? clientFor(o.headers) : base422).post(p, b)),
};

const search = createPolicySearch({ api, t });
const intake = createAssistedIntake({ api, t });
const recent = createRecent({ api, t });
let lobs = [];

/** Search hint with policy-number prefixes the tenant really issues (PA-WI, HO-WI; CA-MI), from GET /config/public. */
function searchHint() {
  const ex = policyExamples(lobs);
  return ex.length ? t('csr.search.hint', { examples: ex.join(t('csr.search.or')) }) : t('csr.search.hintNoExample');
}
function labelStatic() {
  const rk = roleKeys(role);
  document.title = t(rk.title);
  const shell = $('shell');
  shell.setAttribute('product', t('csr.product')); shell.setAttribute('heading', t(rk.heading));
  $('skip').textContent = t('csr.skip');
  $('signin-title').textContent = t('csr.signin.title'); $('signin-body').textContent = t('csr.signin.body');
  $('un-title').textContent = t('csr.unavailable.title');
  $('un-retry').textContent = t('csr.unavailable.retry');
  $('search-sec').setAttribute('heading', t('csr.search.heading'));
  const f = $('search-field');
  f.setAttribute('label', t('csr.search.label')); f.setAttribute('hint', searchHint()); f.setAttribute('required', '');
  $('search-go').textContent = t('csr.search.go');
  $('search-hint').textContent = t('csr.search.typeahead');
  searchTable.setAttribute('caption', t('csr.search.results'));
  $('new-call').textContent = t('csr.newCall');
  $('ctx-card').setAttribute('heading', t('csr.ctx.heading'));
  $('ctx-change').textContent = t('csr.ctx.change');
  $('progress-h').textContent = t('csr.progress.heading');
  $('answer-go').textContent = t('csr.intake.answer');
  $('answer-skip').textContent = t('csr.intake.skip');
  $('answer-optional').textContent = t('csr.intake.optionalHint');
  $('submit-go').textContent = t('csr.submit.go');
  $('panel-h').textContent = t('csr.panel.heading');
  $('script-h').textContent = t('csr.script.heading');
  $('done-sec').setAttribute('heading', t('csr.submit.heading'));
  $('done-again').textContent = t('csr.submit.another');
  $('recent-sec').setAttribute('heading', t('csr.recent.heading'));
  $('recent-refresh').textContent = t('csr.recent.refresh');
  $('recent-hint').textContent = t('csr.recent.footer');
  $('recent-table').setAttribute('caption', t('csr.recent.caption'));
  $('claim-back').textContent = t('csr.claim.back');
  $('stepper').steps = [
    { id: 'search', label: t('csr.step.search') }, { id: 'intake', label: t('csr.step.intake') }, { id: 'submit', label: t('csr.step.submit') },
  ];
}

const fmt = { date: (v) => formatDate(v), money: (v) => formatMoney(v, { cents: false }), enum: (v) => formatEnum(v) };
const toast = (m, kind = 'info') => $('toast').show(m, { kind });
let retryFn = null;
function showUnavailable(fn) {
  retryFn = fn; $('un-body').textContent = t('csr.unavailable.body'); $('unavailable').hidden = false;
  $('un-retry').focus();
}
function hideUnavailable() { $('unavailable').hidden = true; retryFn = null; }
$('un-retry').addEventListener('click', () => { const f = retryFn; hideUnavailable(); f?.(); });

// ---- search (type-ahead + explicit submit)
const cell = (text, cls) => { const sp = document.createElement('span'); if (cls) sp.className = cls; sp.textContent = text; return sp; };
const badge = (value, kind, tone, label) => {
  const b = document.createElement('fx-badge');
  if (tone) { b.setAttribute('tone', tone); b.textContent = label ?? formatEnum(value); } else { b.setAttribute('status', value); if (kind) b.setAttribute('kind', kind); }
  return b;
};
const searchCols = () => [
  { key: 'policyNumber', label: t('csr.search.col.policy'), render: (r) => cell(formatPolicyNumber(r.policyNumber), 'csr-mono') },
  { key: 'insured', label: t('csr.search.col.insured'), render: (r) => {
    const w = document.createElement('span'); w.textContent = r.insured;
    if (r.description) { const sub = document.createElement('span'); sub.className = 'fx-sub'; sub.textContent = r.description; w.appendChild(sub); }
    return w;
  } },
  { key: 'lob', label: t('csr.search.col.lob'), render: (r) => formatEnum(r.lob) },
  { key: 'status', label: t('csr.search.col.status'), render: (r) => badge(r.status, null, policyTone(r.status)) },
  { key: 'period', label: t('csr.search.col.period'), sortable: false, render: (r) => (r.summary?.period?.effectiveDate ? `${formatDate(r.summary.period.effectiveDate)} – ${formatDate(r.summary.period.expirationDate)}` : '') },
];
const searchTable = $('search-table');
search.subscribe((s) => {
  const tbl = searchTable;
  tbl.columns = searchCols(); tbl.rows = s.results;
  $('search-results').hidden = !s.results.length;
  // Detached while empty: a hidden table with a "No results." row is not a result list (and is not clickable).
  if (s.results.length && !tbl.isConnected) $('search-results').appendChild(tbl);
  else if (!s.results.length && tbl.isConnected) tbl.remove();
  $('search-msg').textContent = s.message;
  if (s.phase === 'unavailable') showUnavailable(() => search.retry()); else if (s.phase !== 'searching') hideUnavailable();
});
let typeTimer = null;
$('search-field').addEventListener('fx-change', (e) => {
  clearTimeout(typeTimer);
  const v = String(e.detail?.value ?? '').trim();
  if (!v.length) { typeTimer = setTimeout(() => search.clear(), 150); return; }
  typeTimer = setTimeout(() => search.search(v), 250);
});
$('search-field').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { const first = searchTable.querySelector('tbody tr[tabindex]'); if (first) { e.preventDefault(); first.focus(); } }
});
$('search-form').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(typeTimer); search.search($('search-field').value); });
searchTable.addEventListener('fx-select', (e) => {
  const row = search.select(e.detail.row);
  if (row) beginIntake(row);
});

// ---- policy context (left pane)
let ctxModel = null;
let ctxNote = '';
function renderContext() {
  const body = $('ctx-body'); body.textContent = '';
  if (!ctxModel) return;
  const m = ctxModel;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const head = el('div', 'csr-id');
  head.append(el('span', 'csr-mono', formatPolicyNumber(m.number)), badge(m.status.label, null, m.status.tone, m.status.label));
  body.appendChild(head);
  const kv = el('dl', 'fx-kv');
  kv.append(el('dt', null, t('csr.search.col.lob')), el('dd', null, m.lob), el('dt', null, t('csr.search.col.period')), el('dd', null, m.term || '—'));
  body.appendChild(kv);
  if (m.risk) { kv.append(el('dt', null, t('csr.ctx.risk')), el('dd', null, m.risk)); }
  if (ctxNote) body.appendChild(el('p', 'muted', ctxNote));
  const section = (title) => { const h = el('h3', 'fx-section-title csr-sec-title', title); body.appendChild(h); return h; };
  section(t('csr.ctx.insured'));
  const names = el('ul', 'csr-names');
  for (const n of m.insureds.length ? m.insureds : [{ name: t('csr.ctx.none') }]) names.appendChild(el('li', null, n.name));
  body.appendChild(names);
  if (m.drivers.length) {
    section(t('csr.ctx.drivers'));
    const ul = el('ul', 'csr-names');
    for (const d of m.drivers) { const li = el('li', null, d.name); if (d.excluded) { li.append(' ', badge('excluded', null, 'warning', t('csr.ctx.excluded'))); } ul.appendChild(li); }
    body.appendChild(ul);
  }
  // Policy-level coverages come before the vehicles, so liability limits are visible without scrolling (CSR-21).
  if (m.coverages.length) {
    section(t('csr.ctx.coverages'));
    for (const c of m.coverages) {
      const card = el('div', 'csr-tile'); card.dataset.coverage = c.code;
      const row = el('div', 'csr-tile-head');
      row.append(el('div', 'csr-tile-title', c.title), badge(c.status.label, null, c.status.tone, c.status.label));
      card.appendChild(row);
      if (c.detail) card.append(el('div', 'csr-tile-detail', c.detail));
      body.appendChild(card);
    }
  }
  if (m.vehicles.length) {
    section(t('csr.ctx.vehicles'));
    // A fleet (more than a few units) is folded into one disclosure; a family policy shows its cars open.
    let host = body;
    if (m.collapseVehicles) {
      const det = el('details', 'csr-units'); det.id = 'ctx-units';
      det.appendChild(el('summary', null, t('csr.ctx.vehiclesSummary', { count: m.vehicles.length })));
      body.appendChild(det); host = det;
    }
    for (const v of m.vehicles) {
      const card = el('div', 'csr-tile'); card.dataset.unit = v.id;
      card.append(el('div', 'csr-tile-title', v.title));
      if (v.sub) card.append(el('div', 'csr-tile-detail', v.sub));
      if (v.coverages.length) {
        const ul = el('ul');
        for (const c of v.coverages) { const li = el('li'); li.append(el('span', null, c.title), el('span', null, c.detail)); ul.appendChild(li); }
        card.appendChild(ul);
      }
      host.appendChild(card);
    }
  }
}
let ctxFor = null;
async function loadContext(row) {
  ctxFor = row.policyNumber; ctxNote = t('csr.ctx.loading');
  ctxModel = contextModel({ summary: row.summary, snapshot: null, vehicleOptions: [] }, { t, fmt });
  renderContext();
  let snapshot = null;
  if (!access.policySnapshot) { // the server does not let this role read the snapshot: say so instead of a failed call
    ctxNote = t('csr.ctx.limited.agent');
    ctxModel = contextModel({ summary: row.summary, snapshot: null, vehicleOptions: pickerVehicles }, { t, fmt });
    renderContext();
    return;
  }
  try { snapshot = await api.get(`/policies/${encodeURIComponent(row.policyNumber)}/snapshot`, { asOf: isoDate() }); } catch { snapshot = null; }
  if (ctxFor !== row.policyNumber) return;
  ctxNote = snapshot ? '' : t('csr.ctx.unavailable');
  ctxModel = contextModel({ summary: row.summary, snapshot, vehicleOptions: pickerVehicles }, { t, fmt });
  renderContext();
}

function showStage(stage) {
  $('search-sec').hidden = stage !== 'search';
  $('intake-sec').hidden = stage !== 'intake';
  $('done-sec').hidden = stage !== 'done';
  $('new-call').hidden = stage === 'search';
  $('stepper').setAttribute('current', String({ search: 0, intake: 1, done: 2 }[stage]));
}
function newCall() {
  intake.reset(); renderedQ = null; pickerVehicles = []; renderVehiclePicker(); ctxModel = null; ctxFor = null;
  search.clear(); const box = $('search-field').querySelector('input'); if (box) box.value = '';
  showStage('search');
  $('search-field').querySelector('input')?.focus();
}
$('new-call').addEventListener('click', newCall);
$('ctx-change').addEventListener('click', newCall);

async function beginIntake(row) {
  showStage('intake');
  $('intake-card').setAttribute('heading', t('csr.intake.heading', { policy: formatPolicyNumber(row.policyNumber) }));
  const lob = row.lob || lobs[0]?.id;
  pickerVehicles = [];
  renderVehiclePicker();
  const ctx = loadContext(row);
  await intake.start({ lob, policyNumber: row.policyNumber, locale: document.documentElement.lang || 'en', channel: channelFor(role, lobs, lob) });
  // The picker records the tenant's vehicle-type question; without one (commercial auto today) it is not offered (CSR-12).
  const vq = intake.state.vehicleQuestionId;
  pickerVehicles = vq && access.policyVehicles ? await fetchPolicyVehicles(api, intake.state.sessionId) : [];
  renderVehiclePicker();
  if (vq && pickerVehicles.length) intake.setExternal([vq]); // asked through the picker, not again in the script
  await ctx;
  if (ctxFor === row.policyNumber && !ctxModel?.detailed) { ctxModel = contextModel({ summary: row.summary, snapshot: null, vehicleOptions: pickerVehicles }, { t, fmt }); renderContext(); }
}

// ---- insured vehicle picker (hidden when the policy lists no vehicles)
let pickerVehicles = [];
function renderVehiclePicker() {
  const box = $('vehicle-pick');
  box.textContent = '';
  box.hidden = !pickerVehicles.length;
  if (!pickerVehicles.length) return;
  const f = document.createElement('fx-field');
  f.setAttribute('name', 'insured_vehicle'); f.setAttribute('label', t('csr.sf.vehicle.label')); f.setAttribute('type', 'select'); f.setAttribute('required', '');
  f.options = [{ value: '', label: t('csr.sf.vehicle.choose') }, ...pickerVehicles.map((v) => ({ value: v.unitId, label: v.label }))];
  const note = document.createElement('p'); note.className = 'muted'; note.id = 'vehicle-picked'; note.setAttribute('role', 'status');
  f.addEventListener('change', async (e) => {
    const opt = pickerVehicles.find((v) => v.unitId === e.target.value);
    if (!opt) return;
    await intake.setInsuredVehicle(opt.answer);
    const failure = intake.state.insuredVehicleError;
    note.setAttribute('role', failure ? 'alert' : 'status');
    note.textContent = failure ? t('csr.sf.vehicle.failed', { message: failure }) : t('csr.sf.vehicle.picked', { vehicle: opt.label });
  });
  box.append(f, note);
}

// ---- intake rendering
function buildDisclosure(q, slot) {
  // A native required checkbox: its checked state is sent as boolean true, never a string.
  const wrap = document.createElement('div'); wrap.className = 'fx-check'; wrap.dataset.qtype = q.type;
  const id = `disc-${q.id}`;
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.id = id; cb.name = q.id; cb.required = true; cb.setAttribute('aria-required', 'true');
  const lab = document.createElement('label'); lab.setAttribute('for', id); lab.textContent = resolveText(q.text);
  const err = document.createElement('p'); err.id = `${id}-err`; err.className = 'fx-error'; err.setAttribute('role', 'alert'); err.hidden = true;
  err.textContent = t('kit.field.required', { label: resolveText(q.text) });
  cb.addEventListener('change', () => { err.hidden = cb.checked; cb.removeAttribute('aria-invalid'); });
  wrap.append(cb, lab, err);
  const help = resolveText(q.help);
  if (help) { const h = document.createElement('p'); h.id = `${id}-hint`; h.className = 'muted'; h.textContent = help; cb.setAttribute('aria-describedby', h.id); wrap.appendChild(h); }
  slot.appendChild(wrap);
}
// ---- structured sub-form (party / vehicle / address): one labelled control per field, sends an object value
function buildStructuredForm(q, slot) {
  const fs = document.createElement('fieldset'); fs.className = 'sf'; fs.dataset.qtype = q.type; fs.id = `sf-${q.id}`;
  const lg = document.createElement('legend'); lg.textContent = resolveText(q.text) || t(`csr.sf.legend.${q.type}`);
  const err = document.createElement('p'); err.id = `${fs.id}-err`; err.className = 'fx-error sf-error'; err.setAttribute('role', 'alert'); err.hidden = true;
  fs.append(lg);
  const help = resolveText(q.help);
  if (help) { const h = document.createElement('p'); h.className = 'muted'; h.textContent = help; fs.appendChild(h); }
  const prefill = q.type === 'vehicle' ? (intake.state.insuredVehicle ?? {}) : {};
  for (const fd of structuredFields(q.type)) {
    if (fd.input === 'checkbox') {
      const wrap = document.createElement('div'); wrap.className = 'fx-check';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = `${fs.id}-${fd.key}`; cb.name = fd.key;
      const lab = document.createElement('label'); lab.setAttribute('for', cb.id); lab.textContent = t(`csr.sf.${fd.key}`);
      wrap.append(cb, lab); fs.appendChild(wrap);
      continue;
    }
    const f = document.createElement('fx-field');
    f.setAttribute('name', fd.key); f.setAttribute('label', t(`csr.sf.${fd.key}`)); f.setAttribute('type', fd.input);
    if (fd.required) f.setAttribute('required', '');
    if (fd.autocomplete) f.setAttribute('autocomplete', fd.autocomplete);
    if (fd.input === 'select') f.options = fd.options.map((r) => ({ value: r, label: t(`csr.sf.role.${r}`) }));
    if (fd.input === 'select') f.setAttribute('value', fd.options[0]); // fx-field would otherwise select no option
    if (prefill[fd.key] !== undefined) f.setAttribute('value', String(prefill[fd.key]));
    fs.appendChild(f);
  }
  fs.setAttribute('aria-describedby', err.id);
  fs.appendChild(err);
  slot.appendChild(fs);
}
/** Show (or clear) the server's message for the current structured question next to the sub-form. */
function showStructuredError(msg) {
  const err = document.querySelector('#answer-slot .sf-error');
  if (!err) return;
  err.textContent = msg || ''; err.hidden = !msg;
  const fs = err.closest('fieldset');
  if (msg) fs.setAttribute('aria-invalid', 'true'); else fs.removeAttribute('aria-invalid');
}
/** Multi-select (damaged areas): a fieldset of checkboxes; the answer is the array of ticked option values. */
function buildMultiSelect(q, slot) {
  const fs = document.createElement('fieldset'); fs.className = 'sf csr-multi'; fs.dataset.qtype = q.type; fs.id = `ms-${q.id}`;
  const lg = document.createElement('legend'); lg.textContent = resolveText(q.text);
  fs.appendChild(lg);
  const help = resolveText(q.help);
  if (help) { const h = document.createElement('p'); h.className = 'muted'; h.textContent = help; fs.appendChild(h); }
  (q.options ?? []).forEach((o, i) => {
    const wrap = document.createElement('div'); wrap.className = 'fx-check';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = `${fs.id}-${i}`; cb.name = q.id; cb.value = o.value;
    const lab = document.createElement('label'); lab.setAttribute('for', cb.id); lab.textContent = resolveText(o.label) || o.value;
    wrap.append(cb, lab); fs.appendChild(wrap);
  });
  const err = document.createElement('p'); err.id = `${fs.id}-err`; err.className = 'fx-error sf-error'; err.setAttribute('role', 'alert'); err.hidden = true;
  fs.setAttribute('aria-describedby', err.id);
  fs.appendChild(err);
  slot.appendChild(fs);
}
function buildInput(q) {
  const slot = $('answer-slot'); slot.textContent = '';
  slot.dataset.qid = q?.id ?? ''; // lets tests and assistive tooling tell which question is on screen
  slot.dataset.optional = q && q.required === false ? 'true' : 'false';
  if (!q) return;
  if (isDisclosure(q)) return buildDisclosure(q, slot);
  if (isStructured(q)) return buildStructuredForm(q, slot);
  if (isMultiSelect(q)) return buildMultiSelect(q, slot);
  const f = document.createElement('fx-field');
  f.setAttribute('name', q.id); f.setAttribute('label', resolveText(q.text));
  const help = resolveText(q.help); if (help) f.setAttribute('hint', help);
  if (q.required) f.setAttribute('required', '');
  f.setAttribute('type', fieldType(q.type));
  const rules = fieldRules(q); // the server's length limit, checked here first so the error shows on the field (CSR-15)
  if (rules.maxLength) f.setAttribute('maxlength', String(rules.maxLength));
  const choose = { value: '', label: t('csr.intake.select.choose') }; // an unanswered select must not look answered
  if (q.type === 'select') f.options = [choose, ...(q.options ?? []).map((o) => ({ value: o.value, label: resolveText(o.label) }))];
  if (q.type === 'boolean') f.options = [choose, { value: 'true', label: t('csr.intake.yes') }, { value: 'false', label: t('csr.intake.no') }];
  slot.appendChild(f);
  f.dataset.qtype = q.type;
}
/** Read the current answer control. Returns { ok, value }. */
function readAnswer(q) {
  const slot = $('answer-slot');
  if (isDisclosure(q)) {
    const cb = slot.querySelector('input[type=checkbox]');
    if (!cb) return { ok: false };
    const ok = disclosureAccepted(q, cb.checked);
    if (!ok) { cb.setAttribute('aria-invalid', 'true'); slot.querySelector('.fx-error').hidden = false; cb.focus(); }
    return { ok, value: coerceAnswer(q, cb.checked) };
  }
  if (isStructured(q)) {
    const fs = slot.querySelector('fieldset.sf');
    const raw = {};
    for (const f of fs.querySelectorAll('fx-field')) raw[f.getAttribute('name')] = f.value;
    for (const cb of fs.querySelectorAll('input[type=checkbox]')) raw[cb.name] = cb.checked;
    let first = null; let ok = true;
    const need = new Set(missingStructured(q.type, raw).missing);
    for (const f of fs.querySelectorAll('fx-field')) {
      f.setError(null);
      const bad = need.has(f.getAttribute('name')) || !f.validate();
      if (bad) { ok = false; if (!f.getAttribute('error')) f.setError(t('csr.sf.required', { label: f.getAttribute('label') })); first ??= f; }
    }
    if (!ok) { showStructuredError(t('csr.sf.fix')); first?.querySelector('input,select')?.focus(); return { ok: false }; }
    showStructuredError('');
    return { ok: true, value: buildStructured(q.type, raw) };
  }
  if (isMultiSelect(q)) {
    const ticked = [...slot.querySelectorAll('input[type=checkbox]:checked')].map((cb) => cb.value);
    return { ok: true, value: coerceAnswer(q, ticked) };
  }
  const f = slot.querySelector('fx-field');
  if (!f) return { ok: false };
  f.setError(null); // a server message from the previous attempt is cleared before the field is checked again
  if (!f.validate()) { f.querySelector('input,select,textarea')?.focus(); return { ok: false }; }
  return { ok: true, value: coerceAnswer(q, f.value) };
}
/** Show the server's message for the question on screen next to its control (never as a stack of toasts). */
function showInlineError(q, msg) {
  const slot = $('answer-slot');
  if (!q || slot.dataset.qid !== q.id) return false;
  if (isStructured(q)) { showStructuredError(msg); return true; }
  if (isMultiSelect(q) || isDisclosure(q)) {
    const err = slot.querySelector('.fx-error');
    if (!err) return false;
    err.textContent = msg || (isDisclosure(q) ? t('kit.field.required', { label: resolveText(q.text) }) : '');
    err.hidden = !msg;
    return true;
  }
  const f = slot.querySelector('fx-field');
  if (!f) return false;
  f.setError(msg || null);
  return true;
}
let renderedQ = null;
let lastToast = '';
intake.subscribe((s) => {
  if (s.phase === 'unavailable') { showUnavailable(() => intake.retry()); return; }
  if (s.phase !== 'starting' && s.phase !== 'submitting') hideUnavailable();
  if (s.phase === 'idle') return;
  const optionalOnScreen = !!s.question && s.question.required === false;
  $('progress').textContent = s.done ? t(optionalOnScreen ? 'csr.intake.readyOptional' : 'csr.intake.ready') : t('csr.intake.progress', { answered: s.progress.answered ?? 0, remaining: s.progress.requiredRemaining ?? 0 });
  const pm = progressModel(s.progress, s.done);
  $('progress-fill').style.width = `${pm.percent}%`;
  $('progress-bar').setAttribute('aria-valuenow', String(pm.percent));
  $('progress-bar').setAttribute('aria-valuetext', t('csr.progress.percent', { percent: pm.percent }));
  $('progress-pct').textContent = t('csr.progress.percent', { percent: pm.percent });
  const dis = $('disclosures'); dis.textContent = '';
  if (s.disclosures.length) { const h = document.createElement('h3'); h.textContent = t('csr.intake.disclosures'); dis.appendChild(h); for (const d of s.disclosures) { const p = document.createElement('p'); p.textContent = d; dis.appendChild(p); } }
  renderMissing(document, $('missing'), s, t);
  $('unlisted').textContent = s.unlisted ? t('csr.panel.more', { count: s.unlisted }) : '';
  $('script').textContent = s.script.text;
  if (renderedQ !== (s.question?.id ?? null)) { renderedQ = s.question?.id ?? null; buildInput(s.question); $('answer-slot').querySelector('input,select,textarea')?.focus(); }
  // Server errors (422 errors[]) show on the question's own control; only an error for a question that is not on
  // screen falls back to one toast, and the same message is not toasted twice in a row (CSR-15).
  const mine = s.question ? errorFor(s.errors, s.question.id) : '';
  if (s.question) showInlineError(s.question, mine);
  const others = s.errors.filter((x) => x?.questionId !== s.question?.id).map((x) => x.message).filter(Boolean).join('; ');
  if (others && others !== lastToast) toast(t('csr.intake.fixErrors', { message: others }), 'error');
  lastToast = others;
  $('answer-form').hidden = !s.question;
  $('answer-skip').hidden = !optionalOnScreen;
  $('answer-optional').hidden = !optionalOnScreen;
  // One answer in flight at a time: a second click or Enter while the server is still replying must not re-send.
  const inFlight = s.busy && s.phase !== 'starting';
  $('answer-go').disabled = inFlight;
  $('answer-skip').disabled = inFlight;
  $('answer-form').dataset.busy = inFlight ? 'true' : 'false';
  $('submit-go').hidden = !(s.done && s.phase !== 'submitted');
  if (s.phase === 'submitted' && s.claim) showDone(s.claim);
});
$('answer-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = intake.state.question;
  if (!q || intake.state.busy) return;
  const a = readAnswer(q);
  if (a.ok) intake.answer(q.id, a.value);
});
$('answer-skip').addEventListener('click', () => {
  const q = intake.state.question;
  if (q && q.required === false && !intake.state.busy) intake.skip(q.id);
});
$('submit-go').addEventListener('click', () => intake.submit());

function showDone(claim) {
  showStage('done');
  $('done-h').textContent = t('csr.submit.recorded'); // the card heading already reads "Claim submitted" (CSR-20)
  $('done-number').textContent = t('csr.submit.number', { number: formatClaimNumber(claim.claimNumber ?? '') });
  $('done-status').textContent = claim.status ? t('csr.submit.status', { status: formatEnum(claim.status) }) : '';
  const a = $('done-link'); a.textContent = t('csr.submit.open', { number: formatClaimNumber(claim.claimNumber ?? '') }); a.setAttribute('href', claimLink(claim));
  // Agents cannot open the claim (GET /claims/{id} is not allowed for the role): no dead link, a note instead (CSR-10).
  a.hidden = !access.claimView || !claimLink(claim);
  $('done-note').hidden = access.claimView;
  $('done-note').textContent = access.claimView ? '' : t('csr.submit.agentNote');
  toast(t('csr.submit.done'), 'success');
  $('done-h').focus();
  // The pipeline settles the new claim a moment later (validating -> assigned); keep the list in step (CSR-18).
  if (access.recentClaims && claim.id) recent.refreshUntilSettled(claim.id);
}
$('done-again').addEventListener('click', newCall);

// ---- recent claims + read-only claim
recent.subscribe((s) => {
  if (s.phase === 'unavailable') { showUnavailable(() => recent.retry()); return; }
  if (!access.recentClaims) return; // the agent view explains the section instead (see signedIn)
  const failed = s.phase === 'failed';
  if (s.kind !== 'open') {
    const tbl = $('recent-table'); tbl.columns = recentCells(); tbl.rows = s.rows;
    // A failed load (403, 404, other) says so; it never shows the table's "No results." as if there were no claims.
    tbl.hidden = failed || (s.phase === 'done' && !s.rows.length);
    $('recent-msg').textContent = failed ? s.message : (s.phase === 'done' && !s.rows.length ? t('csr.recent.empty') : '');
  }
  if (!$('claim-sec').hidden && s.kind === 'open') {
    if (s.claim) renderClaim(s.claim);
    else if (failed) showClaimMessage(s.message);
  }
});
function reportedCell(r) {
  const tm = document.createElement('time'); tm.dateTime = r.reportedAt; tm.title = formatDateTime(r.reportedAt); tm.textContent = formatRelative(r.reportedAt); return tm;
}
const claimHref = (id) => `/csr?claim=${encodeURIComponent(id)}`;
/** The claim number is a real link (click, middle-click, keyboard), like the row itself (CSR-19). */
function claimNumberLink(r) {
  if (!r.id) return cell(formatClaimNumber(r.claimNumber), 'csr-ref');
  const a = document.createElement('a'); a.className = 'csr-mono'; a.href = claimHref(r.id); a.textContent = formatClaimNumber(r.claimNumber);
  a.addEventListener('click', (e) => e.stopPropagation()); // the browser follows the link; the row handler must not run too
  a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
  return a;
}
function recentCells() { return recentColumns(t).map((c) => ({
  claimNumber: { ...c, render: claimNumberLink },
  status: { ...c, render: (r) => badge(r.status, 'claim') },
  lob: { ...c, render: (r) => formatEnum(r.lob) },
  policyNumber: { ...c, render: (r) => cell(formatPolicyNumber(r.policyNumber), 'csr-ref') },
  reportedAt: { ...c, render: reportedCell },
}[c.key] ?? c)); }
// A click anywhere on the row (or Enter on a focused row) opens the claim, the same as a search row starts intake.
$('recent-table').addEventListener('fx-select', (e) => { if (e.detail.row?.id) location.assign(claimHref(e.detail.row.id)); });
$('recent-refresh').addEventListener('click', () => recent.load());
/** A missing, forbidden or failed claim says what happened (never an empty card). */
function showClaimMessage(msg) {
  $('claim-dl').textContent = '';
  const box = $('claim-msg'); box.textContent = msg; box.hidden = !msg;
}
function renderClaim(c) {
  $('claim-msg').hidden = true;
  $('claim-sec').setAttribute('heading', t('csr.claim.heading', { number: formatClaimNumber(c.claimNumber ?? '') }));
  const dl = $('claim-dl'); dl.textContent = '';
  for (const f of claimSummary(c, t)) {
    const dt = document.createElement('dt'); dt.textContent = f.label;
    const dd = document.createElement('dd');
    if (f.key === 'status' && c.status) dd.appendChild(badge(c.status, 'claim'));
    else if (f.key === 'lob' && c.lob) dd.textContent = formatEnum(c.lob);
    else if (f.key === 'reportedAt' && c.reportedAt) dd.textContent = formatDateTime(c.reportedAt);
    else if (f.key === 'channel' && c.channel) dd.textContent = formatEnum(c.channel);
    else if (f.key === 'lossDate' && c.lossEvent?.lossDate) dd.textContent = formatDate(c.lossEvent.lossDate);
    else if (f.key === 'policyNumber' && c.policyNumber) dd.textContent = formatPolicyNumber(c.policyNumber);
    else dd.textContent = f.value;
    dl.append(dt, dd);
  }
}

// ---- boot
function showWho() {
  const shell = $('shell');
  const sess = readSession();
  shell.setAttribute('user-name', sess?.persona?.displayName ?? t('csr.signedIn'));
  shell.setAttribute('user-role', t(roleKeys(role).role)); // 'Agent' for the agent persona, 'CSR' otherwise (CSR-11)
}
$('shell').addEventListener('fx-signout', () => {
  clearSession();
  try { sessionStorage.removeItem('csr.token'); } catch { /* ignore */ }
  location.assign('/csr');
});

async function signedIn() {
  $('signin-prompt').hidden = true; $('desk').hidden = false;
  showWho();
  showStage('search');
  try {
    const cfg = await api.get('/config/public');
    lobs = cfg?.lobs ?? []; applyBranding(cfg);
    if (cfg?.displayName) $('shell').setAttribute('tenant-name', cfg.displayName);
  } catch { /* branding optional; unavailable is surfaced by the calls that matter */ }
  $('search-field').setAttribute('hint', searchHint()); // tenant prefixes are known once the config is in
  const claimId = qs.get('claim');
  if (claimId) {
    $('desk').hidden = true; $('claim-sec').hidden = false;
    $('claim-sec').setAttribute('heading', t('csr.claim.heading', { number: '' }).trim());
    if (!access.claimView) { showClaimMessage(t('csr.recent.forbidden.claim')); $('main').focus(); return; }
    await recent.open(claimId);
    if (recent.state.claim) { renderClaim(recent.state.claim); $('claim-sec').scrollIntoView?.(); }
    else if (recent.state.phase === 'failed') showClaimMessage(recent.state.message);
    $('main').focus();
  } else {
    if (access.recentClaims) recent.load();
    else { // agents: the server does not list claims for the role; explain the section instead of a failed call (CSR-10)
      $('recent-table').hidden = true; $('recent-refresh').hidden = true; $('recent-hint').hidden = true;
      $('recent-msg').textContent = t('csr.recent.agent');
    }
    $('search-field').querySelector('input')?.focus();
  }
}

labelStatic();
setLocale(qs.get('lang') || 'en'); labelStatic();
if (token || !isDevMode()) signedIn();
else { $('signin-prompt').hidden = false; showWho(); }
