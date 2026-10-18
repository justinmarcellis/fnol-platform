// CSR portal browser wiring. The only file (with view.js) that imports the shared kit.
import '/shared/components/index.js';
import { createApiClient } from '/shared/api.js';
import { devLogin, isDevMode } from '/shared/devlogin.js';
import { t, registerStrings, setLocale, resolveText } from '/shared/i18n.js';
import { applyBranding } from '/shared/theme.js';
import { registerCsrStrings } from './strings.js';
import { createPolicySearch } from './search.js';
import { createAssistedIntake, claimLink } from './assisted.js';
import { isDisclosure, fieldType, coerceAnswer, disclosureAccepted, isStructured, structuredFields, buildStructured, missingStructured, errorFor, fetchPolicyVehicles } from './answers.js';
import { renderMissing } from './panel.js';
import { createRecent, recentColumns, claimSummary } from './recent.js';
import { isoDate } from './errors.js';

registerCsrStrings(registerStrings);
const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
let token = null;
try { token = sessionStorage.getItem('csr.token'); } catch { /* storage may be blocked */ }

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

function labelStatic() {
  document.title = t('csr.title');
  $('title').textContent = t('csr.title');
  $('skip').textContent = t('csr.skip');
  $('dev-h').textContent = t('csr.dev.heading');
  $('dev-tenant-l').textContent = t('csr.dev.tenant');
  $('dev-role-l').textContent = t('csr.dev.role');
  $('dev-go').textContent = t('csr.dev.go');
  $('un-title').textContent = t('csr.unavailable.title');
  $('un-retry').textContent = t('csr.unavailable.retry');
  $('search-h').textContent = t('csr.search.heading');
  const f = $('search-field');
  f.setAttribute('label', t('csr.search.label')); f.setAttribute('hint', t('csr.search.hint')); f.setAttribute('required', '');
  $('search-go').textContent = t('csr.search.go');
  $('search-hint').textContent = t('csr.search.select');
  $('search-table').setAttribute('caption', t('csr.search.results'));
  $('answer-go').textContent = t('csr.intake.answer');
  $('submit-go').textContent = t('csr.submit.go');
  $('panel-h').textContent = t('csr.panel.heading');
  $('script-h').textContent = t('csr.script.heading');
  $('done-again').textContent = t('csr.submit.another');
  $('recent-h').textContent = t('csr.recent.heading');
  $('recent-refresh').textContent = t('csr.recent.refresh');
  $('recent-hint').textContent = t('csr.recent.hint');
  $('recent-table').setAttribute('caption', t('csr.recent.caption'));
  $('claim-back').textContent = t('csr.claim.back');
  $('stepper').steps = [
    { id: 'search', label: t('csr.step.search') }, { id: 'intake', label: t('csr.step.intake') }, { id: 'submit', label: t('csr.step.submit') },
  ];
}

const toast = (m, kind = 'info') => $('toast').show(m, { kind });
let retryFn = null;
function showUnavailable(fn) {
  retryFn = fn; $('un-body').textContent = t('csr.unavailable.body'); $('unavailable').hidden = false;
  $('un-retry').focus();
}
function hideUnavailable() { $('unavailable').hidden = true; retryFn = null; }
$('un-retry').addEventListener('click', () => { const f = retryFn; hideUnavailable(); f?.(); });

// ---- search
const searchCols = () => [
  { key: 'policyNumber', label: t('csr.search.col.policy') }, { key: 'lob', label: t('csr.search.col.lob') },
  { key: 'status', label: t('csr.search.col.status') }, { key: 'insured', label: t('csr.search.col.insured') },
  { key: 'period', label: t('csr.search.col.period') },
];
search.subscribe((s) => {
  const tbl = $('search-table');
  tbl.columns = searchCols(); tbl.rows = s.results;
  $('search-msg').textContent = s.message;
  if (s.phase === 'unavailable') showUnavailable(() => search.retry()); else if (s.phase !== 'searching') hideUnavailable();
});
$('search-form').addEventListener('submit', (e) => { e.preventDefault(); search.search($('search-field').value); });
$('search-table').addEventListener('fx-select', (e) => {
  const row = search.select(e.detail.row);
  if (row) beginIntake(row);
});

async function beginIntake(row) {
  $('stepper').setAttribute('current', '1');
  $('search-sec').hidden = true; $('intake-sec').hidden = false;
  $('intake-h').textContent = t('csr.intake.heading', { policy: row.policyNumber });
  const lob = row.lob || lobs[0]?.id;
  pickerVehicles = [];
  renderVehiclePicker();
  await intake.start({ lob, policyNumber: row.policyNumber, locale: document.documentElement.lang || 'en' });
  $('intake-h').focus();
  pickerVehicles = await fetchPolicyVehicles(api, intake.state.sessionId);
  renderVehiclePicker();
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
function buildInput(q) {
  const slot = $('answer-slot'); slot.textContent = '';
  if (!q) return;
  if (isDisclosure(q)) return buildDisclosure(q, slot);
  if (isStructured(q)) return buildStructuredForm(q, slot);
  const f = document.createElement('fx-field');
  f.setAttribute('name', q.id); f.setAttribute('label', resolveText(q.text));
  const help = resolveText(q.help); if (help) f.setAttribute('hint', help);
  if (q.required) f.setAttribute('required', '');
  f.setAttribute('type', fieldType(q.type));
  if (q.type === 'select') f.options = (q.options ?? []).map((o) => ({ value: o.value, label: resolveText(o.label) }));
  if (q.type === 'boolean') f.options = [{ value: 'true', label: t('csr.intake.yes') }, { value: 'false', label: t('csr.intake.no') }];
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
  const f = slot.querySelector('fx-field');
  if (!f || !f.validate()) return { ok: false };
  return { ok: true, value: coerceAnswer(q, f.value) };
}
let renderedQ = null;
intake.subscribe((s) => {
  if (s.phase === 'unavailable') { showUnavailable(() => intake.retry()); return; }
  if (s.phase !== 'starting' && s.phase !== 'submitting') hideUnavailable();
  if (s.phase === 'idle') return;
  $('progress').textContent = s.done ? t('csr.intake.ready') : t('csr.intake.progress', { answered: s.progress.answered ?? 0, remaining: s.progress.requiredRemaining ?? 0 });
  const dis = $('disclosures'); dis.textContent = '';
  if (s.disclosures.length) { const h = document.createElement('h3'); h.textContent = t('csr.intake.disclosures'); dis.appendChild(h); for (const d of s.disclosures) { const p = document.createElement('p'); p.textContent = d; dis.appendChild(p); } }
  renderMissing(document, $('missing'), s, t);
  $('unlisted').textContent = s.unlisted ? t('csr.panel.more', { count: s.unlisted }) : '';
  $('script').textContent = s.script.text;
  if (renderedQ !== (s.question?.id ?? null)) { renderedQ = s.question?.id ?? null; buildInput(s.question); $('answer-slot').querySelector('input,select,textarea')?.focus(); }
  const sfMsg = s.question && isStructured(s.question) ? errorFor(s.errors, s.question.id) : '';
  if (s.question && isStructured(s.question)) showStructuredError(sfMsg);
  if (s.errors.length) toast(t('csr.intake.fixErrors', { message: s.errors.map((x) => x.message).join('; ') }), 'error');
  $('answer-form').hidden = !s.question;
  $('submit-go').hidden = !(s.done && s.phase !== 'submitted');
  if (s.phase === 'submitted' && s.claim) showDone(s.claim);
});
$('answer-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = intake.state.question;
  if (!q) return;
  const a = readAnswer(q);
  if (a.ok) intake.answer(q.id, a.value);
});
$('submit-go').addEventListener('click', () => intake.submit());

function showDone(claim) {
  $('intake-sec').hidden = true; $('done-sec').hidden = false;
  $('stepper').setAttribute('current', '2');
  $('done-h').textContent = t('csr.submit.done');
  $('done-number').textContent = t('csr.submit.number', { number: claim.claimNumber ?? '' });
  const a = $('done-link'); a.textContent = t('csr.submit.open', { number: claim.claimNumber ?? '' }); a.setAttribute('href', claimLink(claim));
  toast(t('csr.submit.done'), 'success');
  $('done-h').focus();
  recent.load();
}
$('done-again').addEventListener('click', () => {
  intake.reset(); renderedQ = null; pickerVehicles = []; renderVehiclePicker();
  $('done-sec').hidden = true; $('search-sec').hidden = false; $('stepper').setAttribute('current', '0'); $('search-h').focus();
});

// ---- recent claims + read-only claim
recent.subscribe((s) => {
  if (s.phase === 'unavailable') { showUnavailable(() => recent.retry()); return; }
  const tbl = $('recent-table'); tbl.columns = recentColumns(t); tbl.rows = s.rows;
  if (s.claim && !$('claim-sec').hidden) renderClaim(s.claim);
});
$('recent-table').addEventListener('fx-select', (e) => { if (e.detail.row?.id) location.assign(`/csr?claim=${encodeURIComponent(e.detail.row.id)}`); });
$('recent-refresh').addEventListener('click', () => recent.load());
function renderClaim(c) {
  $('claim-h').textContent = t('csr.claim.heading', { number: c.claimNumber ?? '' });
  const dl = $('claim-dl'); dl.textContent = '';
  for (const f of claimSummary(c, t)) { const dt = document.createElement('dt'); dt.textContent = f.label; const dd = document.createElement('dd'); dd.textContent = f.value; dl.append(dt, dd); }
}

// ---- boot
async function signedIn() {
  $('dev-panel').hidden = true; $('desk').hidden = false;
  $('whoami').textContent = t('csr.signedIn');
  try {
    const cfg = await api.get('/config/public');
    lobs = cfg?.lobs ?? []; applyBranding(cfg);
  } catch { /* branding optional; unavailable is surfaced by the calls that matter */ }
  const claimId = qs.get('claim');
  if (claimId) {
    $('desk').hidden = true; $('claim-sec').hidden = false;
    await recent.open(claimId);
    if (recent.state.claim) { renderClaim(recent.state.claim); $('claim-h').focus(); }
  } else {
    recent.load();
    $('search-h').focus();
  }
}

labelStatic();
setLocale(qs.get('lang') || 'en'); labelStatic();
if (isDevMode()) {
  const extra = qs.get('tenant');
  if (extra && /^[a-z0-9_-]{1,40}$/i.test(extra)) { const o = document.createElement('option'); o.value = o.textContent = extra; $('dev-tenant').prepend(o); $('dev-tenant').value = extra; }
  $('dev-panel').hidden = !!token;
  $('dev-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await devLogin(base, { tenant: $('dev-tenant').value, role: 'csr' });
      token = res?.token ?? null;
      try { sessionStorage.setItem('csr.token', token); } catch { /* ignore */ }
      await signedIn();
    } catch (err) {
      if (err?.code === 'service_unavailable' || !err?.status) showUnavailable(() => $('dev-form').requestSubmit());
      else toast(t('csr.error.generic', { message: err?.message ?? '' }), 'error');
    }
  });
}
if (token || !isDevMode()) signedIn();
