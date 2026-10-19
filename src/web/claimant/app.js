// Claimant web app (browser entry). Wires the shared kit to the pure logic modules.
import { createApiClient } from '/shared/api.js';
import { t, setLocale, getLocale, registerStrings } from '/shared/i18n.js';
import { applyBranding } from '/shared/theme.js';
import { devLogin } from '/shared/devlogin.js';
import { registerClaimantStrings, localText } from './strings.js';
import { createIntakeFlow } from './flow.js';
import { createChat } from './chat.js';
import { createStatusPoller, buildTimeline, DEFAULT_INTERVAL_MS } from './status.js';
import { createUploader, KINDS, MAX_BYTES, ACCEPT_ATTR } from './upload.js';
import { h, buildInput, renderTimeline } from './view.js';
import { fetchPolicyVehicles, errorFor } from './structured.js';

try { await import('/shared/components/index.js'); } catch { /* kit components are optional; fallbacks render */ }

const TENANTS = [
  { id: 'aurelia-mutual', name: 'Aurelia Mutual' },
  { id: 'kestrel-point', name: 'Kestrel Point' }
];
const LS_LANG = 'fnol.claimant.lang';
const LS_TENANT = 'fnol.claimant.tenant';
const $ = (id) => document.getElementById(id);
const main = $('main');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } }
};

registerClaimantStrings(registerStrings);
// S5-WFL-04 holder check strings (kept here: strings.js belongs to another ticket).
registerStrings('en', {
  'claimant.holder.heading': 'Confirm your policy to choose your insured vehicle',
  'claimant.holder.lastName': 'Last name on the policy',
  'claimant.holder.zip': 'ZIP code where the vehicle is kept or mail is sent',
  'claimant.holder.submit': 'Find my vehicles',
  'claimant.holder.failed': 'We could not confirm that policy with those details. Check them and try again, or continue without choosing a vehicle.',
  'claimant.holder.zipInvalid': 'Enter a 5-digit ZIP code.',
});
registerStrings('es', {
  'claimant.holder.heading': 'Confirme su póliza para elegir su vehículo asegurado',
  'claimant.holder.lastName': 'Apellido en la póliza',
  'claimant.holder.zip': 'Código postal donde se guarda el vehículo o se envía el correo',
  'claimant.holder.submit': 'Buscar mis vehículos',
  'claimant.holder.failed': 'No pudimos confirmar esa póliza con esos datos. Revíselos e inténtelo de nuevo, o continúe sin elegir un vehículo.',
  'claimant.holder.zipInvalid': 'Ingrese un código postal de 5 dígitos.',
});

let token = null; // memory only
// Adapter over the kit client: adds per-call headers (Idempotency-Key) and accepts a FormData for upload.
const extraHeaders = new Map();
const kitApi = createApiClient({
  getToken: () => token,
  fetchImpl: (url, init) => {
    const key = `${init.method} ${new URL(url, location.href).pathname}`;
    const extra = extraHeaders.get(key);
    extraHeaders.delete(key);
    return fetch(url, extra ? { ...init, headers: { ...init.headers, ...extra } } : init).then(async (res) => {
      if (res.status === 422) { try { last422 = await res.clone().json(); } catch { last422 = null; } }
      return res;
    });
  }
});
const api = {
  get: (path, query) => kitApi.get(path, query),
  post(path, body, opts) {
    if (opts?.headers) extraHeaders.set(`POST /api/v1${path}`, opts.headers);
    return kitApi.post(path, body);
  },
  upload(path, form) {
    const file = form.get('file');
    const fields = {};
    for (const [k, v] of form.entries()) if (k !== 'file') fields[k] = v;
    return kitApi.upload(path, file, fields);
  }
};
// The shared client drops the body of a 422; keep the intake step so per-question errors[] reach the sub-form.
let last422 = null;
const rawApiPost = api.post.bind(api);
api.post = async (path, body, opts) => {
  last422 = null;
  try { return await rawApiPost(path, body, opts); } catch (err) {
    if (err?.status === 422 && Array.isArray(last422?.errors)) err.errors = last422.errors;
    throw err;
  }
};
const app = { policyNumber: '', vehicles: [], pickedUnit: null, draft: null, tenant: null, config: null, mode: 'guided', lob: null, lossType: null, flow: null, chat: null, poller: null, uploader: null, unsubs: [], view: 'boot' };

const announce = (msg) => { const live = $('live'); live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); };
const focusMain = (el) => { (el ?? main).focus({ preventScroll: false }); };
const teardown = () => { app.unsubs.forEach((u) => u()); app.unsubs = []; app.poller?.stop(); app.poller = null; };

function pickTenant() {
  const fromUrl = new URLSearchParams(location.search).get('tenant');
  const ok = (id) => TENANTS.some((x) => x.id === id);
  return [fromUrl, store.get(LS_TENANT)].find(ok) ?? TENANTS[0].id;
}

function applyLocale(loc) {
  setLocale(loc);
  document.documentElement.lang = loc;
  store.set(LS_LANG, loc);
  chrome();
}

/** Header strings, tenant and language pickers. */
function chrome() {
  document.title = t('claimant.title');
  $('skip').textContent = t('claimant.skip');
  $('tenant-label').textContent = t('claimant.tenant.label');
  $('lang-label').textContent = t('claimant.lang.label');
  const tp = $('tenant-picker');
  tp.replaceChildren(...TENANTS.map((x) => h('option', { value: x.id, text: x.name, selected: x.id === app.tenant })));
  const locales = app.config?.locales ?? [];
  const showLang = locales.includes('es');
  $('lang-wrap').hidden = !showLang;
  if (showLang) {
    $('lang-picker').replaceChildren(...['en', 'es'].filter((l) => locales.includes(l) || l === 'en').map((l) => h('option', { value: l, text: t(`claimant.lang.${l}`), selected: l === getLocale() })));
  }
}

function setBrand(cfg) {
  try { applyBranding(cfg); } catch { /* invalid branding is ignored by the kit */ }
  $('brand-name').textContent = cfg?.displayName ?? '';
  const logo = $('logo');
  const url = cfg?.branding?.logoUrl;
  if (url && /^(\/|https?:)/.test(url)) { logo.src = url; logo.hidden = false; } else logo.hidden = true;
}

// ---------------------------------------------------------------- views
function showUnavailable(retry) {
  app.view = 'unavailable';
  app.poller?.stop();
  const btn = h('button', { class: 'btn', type: 'button', onclick: retry }, t('claimant.unavailable.retry'));
  const box = h('section', { class: 'alert', role: 'alert' },
    h('h1', { id: 'view-title', tabindex: '-1', text: t('claimant.unavailable.title') }),
    h('p', { text: t('claimant.unavailable.body') }),
    btn);
  main.replaceChildren(box);
  announce(t('claimant.unavailable.title'));
  $('view-title').focus();
}

async function boot() {
  teardown();
  app.view = 'boot';
  main.replaceChildren(h('p', { text: t('claimant.loading') }));
  try {
    const login = await devLogin(api, { tenant: app.tenant, role: 'claimant' });
    token = login.token;
    app.config = await api.get('/config/public');
  } catch (err) {
    token = null;
    return showUnavailable(boot);
  }
  setBrand(app.config);
  const stored = store.get(LS_LANG);
  const loc = stored && (app.config.locales ?? ['en']).includes(stored) ? stored : 'en';
  applyLocale(loc);
  showStart();
}

function enabledLobs() { return (app.config?.lobs ?? []).filter((l) => l.enabled); }

function showStart() {
  teardown();
  app.view = 'start';
  const lobs = enabledLobs();
  const locale = getLocale();
  if (!lobs.length) {
    main.replaceChildren(h('h1', { id: 'view-title', tabindex: '-1', text: t('claimant.start.heading') }), h('p', { text: t('claimant.start.noLobs') }));
    return $('view-title').focus();
  }
  app.lob ??= lobs[0].id;
  if (!lobs.some((l) => l.id === app.lob)) app.lob = lobs[0].id;
  // Loss type is asked first: it selects the tenant question set (e.g. auto glass). Re-rendered when the line changes.
  const lossFs = h('fieldset', { id: 'loss-fs' });
  const renderLoss = () => {
    const types = lobs.find((l) => l.id === app.lob)?.lossTypes ?? [];
    if (!types.some((x) => x.id === app.lossType)) app.lossType = types[0]?.id ?? null;
    lossFs.hidden = !types.length;
    lossFs.replaceChildren(h('legend', { text: t('claimant.start.lossType') }),
      ...types.map((x) => h('label', { class: 'opt' }, h('input', { type: 'radio', name: 'lossType', value: x.id, checked: x.id === app.lossType || null, onchange: () => { app.lossType = x.id; } }), h('span', { text: localText(x.label, locale) || x.id }))));
  };
  const lobFs = h('fieldset', {}, h('legend', { text: t('claimant.start.lob') }),
    lobs.map((l) => h('label', { class: 'opt' }, h('input', { type: 'radio', name: 'lob', value: l.id, checked: l.id === app.lob || null, onchange: () => { app.lob = l.id; renderLoss(); } }), h('span', { text: localText(l.label, locale) || l.id }))));
  renderLoss();
  const modeFs = h('fieldset', {}, h('legend', { text: t('claimant.start.mode') }),
    [['guided', 'claimant.start.guided', 'claimant.start.guidedHelp'], ['chat', 'claimant.start.chat', 'claimant.start.chatHelp']].map(([v, a, b]) =>
      h('label', { class: 'opt' }, h('input', { type: 'radio', name: 'mode', value: v, checked: app.mode === v || null, onchange: () => { app.mode = v; } }), h('span', {}, t(a), h('small', { text: t(b) })))));
  const err = h('p', { class: 'field-error', id: 'start-error', role: 'alert' });
  const policyIn = h('input', { type: 'text', id: 'policy-number', name: 'policyNumber', autocomplete: 'off', 'aria-describedby': 'policy-number-help', value: app.policyNumber || null, onchange: (e) => { app.policyNumber = e.target.value.trim(); } });
  const policyBox = h('div', {}, h('label', { for: 'policy-number', text: t('claimant.start.policy') }), h('p', { class: 'help', id: 'policy-number-help', text: t('claimant.start.policyHelp') }), policyIn);
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); app.policyNumber = policyIn.value.trim(); startSession(); } }, lobFs, lossFs, policyBox, modeFs, err, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, t('claimant.start.go'))));
  main.replaceChildren(h('h1', { id: 'view-title', tabindex: '-1', text: t('claimant.start.heading') }), h('p', { class: 'muted', text: t('claimant.start.intro') }), form);
  app.startError = err;
  $('view-title').focus();
}

async function startSession() {
  const flow = createIntakeFlow({ api });
  app.flow = flow;
  app.chat = app.mode === 'chat' ? createChat({ flow, t: (k, p) => t(k, p), locale: getLocale }) : null;
  teardown();
  app.unsubs.push(flow.subscribe(onFlow));
  app.vehicles = []; app.pickedUnit = null; app.draft = null; app.holder = { failed: false, busy: false };
  await flow.start({ lob: app.lob, lossType: app.lossType ?? undefined, locale: getLocale(), policyNumber: app.policyNumber || undefined });
  if (app.policyNumber && flow.state.sessionId && app.view === 'guided') showGuided(flow.state); // reveals the holder check
}

/** Holder check (S5-WFL-04): last name + ZIP, then the vehicles. Values live only in the inputs and the request. */
async function verifyHolder(lastName, zip) {
  app.holder = { failed: false, busy: true };
  const rows = await fetchPolicyVehicles(api, app.flow.state.sessionId, { lastName, zip });
  app.vehicles = rows;
  app.holder = { failed: !rows.length, busy: false };
  showGuided(app.flow.state);
  if (!rows.length) { announce(t('claimant.holder.failed')); $('holder-last-name')?.focus(); }
}

function holderForm() {
  if (!app.policyNumber || app.vehicles.length) return null;
  const zipErr = h('p', { id: 'holder-zip-error', class: 'field-error', role: 'alert', hidden: true, text: t('claimant.holder.zipInvalid') });
  const failed = h('p', { id: 'holder-error', class: 'field-error', role: 'alert', hidden: app.holder?.failed ? null : true, text: app.holder?.failed ? t('claimant.holder.failed') : '' });
  const last = h('input', { id: 'holder-last-name', name: 'holder_last_name', type: 'text', autocomplete: 'family-name' });
  const zip = h('input', { id: 'holder-zip', name: 'holder_zip', type: 'text', inputmode: 'numeric', autocomplete: 'postal-code', maxlength: '10', 'aria-describedby': 'holder-zip-error' });
  // A group, not a <form>: the question form stays the only form in main.
  const go = () => {
    zipErr.hidden = /^\d{5}(-?\d{4})?$/.test(zip.value.trim());
    if (!zipErr.hidden) return zip.focus();
    verifyHolder(last.value, zip.value);
  };
  const enter = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  last.addEventListener('keydown', enter); zip.addEventListener('keydown', enter);
  return h('div', { id: 'holder-check', class: 'card', role: 'group', 'aria-labelledby': 'holder-heading' },
  h('h2', { id: 'holder-heading', text: t('claimant.holder.heading') }),
  h('label', { for: 'holder-last-name', text: t('claimant.holder.lastName') }), last,
  h('label', { for: 'holder-zip', text: t('claimant.holder.zip') }), zip, zipErr, failed,
  h('div', { class: 'row' }, h('button', { class: 'btn secondary', type: 'button', onclick: go, disabled: app.holder?.busy || null }, t('claimant.holder.submit'))));
}

/** Insured vehicle picker: only rendered when the policy lists vehicles. */
function vehiclePicker() {
  if (!app.vehicles.length) return null;
  const sel = h('select', { id: 'insured-vehicle', name: 'insured_vehicle', onchange: (e) => {
    const opt = app.vehicles.find((v) => v.unitId === e.target.value);
    app.pickedUnit = opt?.unitId ?? null;
    if (opt) { app.refocusPicker = true; app.flow.setInsuredVehicle(opt.answer); }
  } }, h('option', { value: '', text: t('claimant.sf.vehicle.choose') }),
  app.vehicles.map((v) => h('option', { value: v.unitId, text: v.label, selected: v.unitId === app.pickedUnit || null })));
  const failure = app.flow?.state?.insuredVehicleError;
  const err = h('p', { id: 'vehicle-error', class: 'field-error', role: 'alert', hidden: failure ? null : true, text: failure ? t('claimant.sf.vehicle.failed', { message: failure }) : '' });
  return h('div', { id: 'vehicle-pick', class: 'card' }, h('label', { for: 'insured-vehicle', text: t('claimant.sf.vehicle.label') }), sel, err);
}

let lastQid = null;
function onFlow(s) {
  if (s.phase === 'unavailable') return showUnavailable(() => app.flow.retry());
  if (s.phase === 'idle') {
    if (s.error && app.view === 'start' && app.startError) app.startError.textContent = t('claimant.error.generic', { message: s.error.message });
    return;
  }
  if (s.phase === 'starting' || s.phase === 'submitting') {
    announce(s.phase === 'submitting' ? t('claimant.submitting') : t('claimant.loading'));
    return;
  }
  if (s.phase === 'submitted') return showSubmitted(s.claim);
  if (app.mode === 'chat') return showChat(s);
  showGuided(s);
  lastQid = s.question?.id;
}

function progressBar(s) {
  const p = s.progress ?? {};
  return h('div', { class: 'progress' },
    h('progress', { max: 100, value: p.percent ?? 0, 'aria-label': t('claimant.guided.progress', { answered: p.answered ?? 0, remaining: p.requiredRemaining ?? 0 }) }),
    h('span', { class: 'muted', text: t('claimant.guided.progress', { answered: p.answered ?? 0, remaining: p.requiredRemaining ?? 0 }) }));
}

function disclosures(s) {
  return (s.disclosures ?? []).map((d) => h('p', { class: 'disclosure', text: d }));
}

function submitBlock(s) {
  return h('section', { class: 'card' },
    h('h2', { id: 'review-title', tabindex: '-1', text: t('claimant.review.heading') }),
    h('p', { text: t('claimant.review.body') }),
    h('button', { class: 'btn', type: 'button', onclick: () => app.flow.submit() }, t('claimant.review.submit')));
}

/** Guided mode: exactly the question the server returned, one at a time. */
function showGuided(s) {
  app.view = 'guided';
  const root = [h('h1', { id: 'view-title', tabindex: '-1', text: t('claimant.title') }), progressBar(s), ...disclosures(s), holderForm(), vehiclePicker()].filter(Boolean);
  let focusTarget = $('view-title');
  if (s.question) {
    const errId = 'q-error';
    const draft = app.draft?.qid === s.question.id ? app.draft.raw : undefined;
    const input = buildInput(s.question, { locale: getLocale(), t, errorId: s.errors.length ? errId : null, initial: draft });
    const own = errorFor(s.errors, s.question.id);
    const errs = s.errors.length ? h('p', { class: 'field-error', id: errId, role: 'alert', text: own || s.errors.map((e) => e.message).join(' ') }) : null;
    const missing = h('p', { class: 'field-error', role: 'alert', hidden: true, text: t('claimant.guided.required') });
    const form = h('form', { onsubmit: (e) => {
      e.preventDefault();
      if (input.raw) app.draft = { qid: s.question.id, raw: input.raw() };
      if (input.check && !input.check()) return;
      const v = input.get();
      if (v === undefined) {
        if (s.question.required) { missing.hidden = false; return input.focus(); }
        return app.flow.answer(s.question.id, null);
      }
      app.flow.answer(s.question.id, v);
    } }, input.el, errs, missing, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit', disabled: s.busy || null }, t('claimant.guided.next'))));
    root.push(form);
    focusTarget = { focus: () => input.focus() };
    if (s.question.id !== lastQid) announce(localText(s.question.text, getLocale()));
  } else if (s.phase === 'ready') {
    root.push(submitBlock(s));
    focusTarget = { focus: () => $('review-title')?.focus() };
  }
  main.replaceChildren(...root);
  if (app.refocusPicker && $('insured-vehicle')) { app.refocusPicker = false; $('insured-vehicle').focus(); } else focusTarget.focus();
}

/** Conversational mode. */
function showChat(s) {
  const first = app.view !== 'chat';
  app.view = 'chat';
  if (first) {
    const log = h('ol', { class: 'log', id: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': t('claimant.chat.log'), tabindex: '0' });
    const input = h('textarea', { id: 'chat-input', rows: 2, 'aria-label': t('claimant.chat.input'), onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
    const send = () => { const v = input.value; if (!v.trim()) return; input.value = ''; app.chat.sendText(v).then(() => input.focus()); };
    const form = h('form', { onsubmit: (e) => { e.preventDefault(); send(); } }, h('label', { for: 'chat-input', class: 'sr-only', text: t('claimant.chat.input') }), input, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, t('claimant.chat.send'))));
    main.replaceChildren(h('h1', { id: 'view-title', tabindex: '-1', text: t('claimant.chat.heading') }), progressBar(s), log, h('div', { id: 'chat-form' }, form), h('div', { id: 'chat-submit' }));
    app.unsubs.push(app.chat.subscribe(renderLog));
    input.focus();
  } else {
    main.querySelector('.progress')?.replaceWith(progressBar(s));
  }
  const submitSlot = $('chat-submit');
  if (submitSlot) {
    submitSlot.replaceChildren(s.phase === 'ready' ? submitBlock(s) : '');
    $('chat-form').hidden = s.phase === 'ready' && !s.question;
  }
}

function renderLog(messages) {
  const log = $('chat-log');
  if (!log) return;
  log.replaceChildren(...messages.filter((m) => m.status !== 'dismissed').map(messageEl));
  log.scrollTop = log.scrollHeight;
}

function messageEl(m) {
  const who = m.role === 'user' ? t('claimant.chat.you') : t('claimant.chat.assistant');
  const li = h('li', { class: `msg ${m.role}${m.kind === 'error' ? ' error' : ''}` }, h('span', { class: 'who', text: who }), h('span', { text: m.text }));
  if (m.help) li.append(h('span', { class: 'ai-note', text: m.help }));
  if (m.kind === 'suggestion') {
    if (m.ai) {
      li.append(h('p', { class: 'ai-note', text: t('claimant.chat.ai', { provider: m.ai.provider ?? '', model: m.ai.model ?? '', confidence: Math.round((m.ai.confidence ?? 0) * 100) }) }));
      if (m.ai.explanation) li.append(h('p', { class: 'ai-note', text: t('claimant.chat.aiWhy', { explanation: m.ai.explanation }) }));
    }
    if (m.status === 'pending') {
      const edit = h('input', { type: 'text', 'aria-label': t('claimant.chat.edit'), value: m.shown ?? '', hidden: true });
      const saveBtn = h('button', { class: 'btn secondary', type: 'button', hidden: true, onclick: () => app.chat.editSuggestion(m.questionId, edit.value) }, t('claimant.chat.save'));
      const editBtn = h('button', { class: 'btn secondary', type: 'button', onclick: () => { edit.hidden = false; saveBtn.hidden = false; editBtn.hidden = true; edit.focus(); } }, t('claimant.chat.edit'));
      li.append(h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => app.chat.confirmSuggestion(m.questionId) }, t('claimant.chat.confirm')), editBtn), edit, saveBtn);
    } else li.append(h('span', { class: 'ai-note', text: t('claimant.chat.confirmed') }));
  }
  return li;
}

// ---------------------------------------------------------------- after submit
function showSubmitted(claim) {
  teardown();
  app.view = 'submitted';
  app.uploader = createUploader({ api, claimId: claim.id });
  const filesList = h('ul', { class: 'files', 'aria-live': 'polite' });
  const kind = h('select', { id: 'ev-kind' }, KINDS.map((k) => h('option', { value: k, text: t(`claimant.evidence.kind.${k}`) })));
  const picker = h('input', { type: 'file', id: 'ev-files', multiple: true, accept: ACCEPT_ATTR, onchange: async () => {
    const files = [...picker.files]; picker.value = '';
    for (const f of files) await app.uploader.add(f, kind.value);
  } });
  app.unsubs.push(app.uploader.subscribe((items) => {
    filesList.replaceChildren(...items.map((i) => {
      const text = i.status === 'uploading' ? t('claimant.evidence.uploading', { name: i.name })
        : i.status === 'done' ? t('claimant.evidence.done', { name: i.name })
        : i.code === 'tooLarge' ? t('claimant.evidence.tooLarge', { name: i.name, max: MAX_BYTES / 1048576 })
        : i.code === 'badType' ? t('claimant.evidence.badType', { name: i.name })
        : t('claimant.evidence.failed', { name: i.name });
      return h('li', {}, h('span', { text: text }), i.status === 'error' ? h('button', { class: 'btn secondary', type: 'button', onclick: () => app.uploader.retry(i.id) }, t('claimant.evidence.retry')) : null);
    }));
  }));

  const statusBox = h('div', { id: 'status-box' });
  const note = h('p', { class: 'muted', role: 'status', id: 'status-note' });
  const refresh = h('button', { class: 'btn secondary', type: 'button', onclick: () => app.poller?.refresh() }, t('claimant.status.refresh'));

  main.replaceChildren(
    h('h1', { id: 'view-title', tabindex: '-1', text: t('claimant.submitted.heading') }),
    h('section', { class: 'card' }, h('p', { class: 'muted', text: t('claimant.submitted.number') }), h('p', { class: 'claim-number', id: 'claim-number', text: claim.claimNumber }), h('p', { text: t('claimant.submitted.keep') })),
    h('section', {}, h('h2', { text: t('claimant.evidence.heading') }), h('p', { class: 'help', text: t('claimant.evidence.help', { max: MAX_BYTES / 1048576 }) }),
      h('label', { for: 'ev-kind', text: t('claimant.evidence.kind') }), kind,
      h('label', { for: 'ev-files', class: 'sr-only', text: t('claimant.evidence.choose') }), h('div', { class: 'row' }, picker), filesList),
    h('section', {}, h('h2', { text: t('claimant.status.heading') }), statusBox, note, h('div', { class: 'row' }, refresh)));
  announce(`${t('claimant.submitted.heading')} ${claim.claimNumber}`);
  $('view-title').focus();

  // Show the status we already have, then poll.
  statusBox.replaceChildren(renderTimeline(buildTimeline(claim, t), claim, t));
  const poller = createStatusPoller({ api, claimId: claim.id, intervalMs: DEFAULT_INTERVAL_MS, isHidden: () => document.hidden });
  app.poller = poller;
  let lastStatus = claim.status;
  app.unsubs.push(poller.subscribe((s) => {
    if (s.claim) {
      statusBox.replaceChildren(renderTimeline(buildTimeline(s.claim, t), s.claim, t));
      if (s.status !== lastStatus) { lastStatus = s.status; announce(t(`claimant.status.${s.status}`)); }
    }
    note.textContent = s.final ? t('claimant.status.final', { status: t(`claimant.status.${s.status}`) })
      : s.stale ? t('claimant.status.stale')
      : s.paused ? t('claimant.status.paused')
      : s.checkedAt ? t('claimant.status.updated', { time: new Date(s.checkedAt).toLocaleTimeString(getLocale()) }) : '';
    refresh.hidden = !!s.final;
  }));
  poller.start();
}

document.addEventListener('visibilitychange', () => app.poller?.setHidden(document.hidden));

$('tenant-picker').addEventListener('change', (e) => {
  app.tenant = e.target.value;
  store.set(LS_TENANT, app.tenant);
  const url = new URL(location.href); url.searchParams.set('tenant', app.tenant);
  history.replaceState(null, '', url);
  app.lob = null; app.config = null;
  boot();
});
$('lang-picker').addEventListener('change', (e) => {
  applyLocale(e.target.value);
  if (app.view === 'start') showStart();
  else if (app.view === 'guided' && app.flow) { lastQid = null; showGuided(app.flow.state); }
  else if (app.view === 'chat') { app.view = 'chat-rebuild'; showChat(app.flow.state); }
  else if (app.view === 'submitted') { /* strings refresh on the next poll; keep state */ }
});

app.tenant = pickTenant();
store.set(LS_TENANT, app.tenant);
chrome();
boot();
