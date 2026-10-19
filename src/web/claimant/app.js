// Claimant web app (browser entry). Wires the shared kit and design system to the pure logic modules.
// Mobile-first guided FNOL: welcome, details, one question per step, review, confirmation with status.
import { createApiClient } from '/shared/api.js';
import { t, setLocale, getLocale, registerStrings } from '/shared/i18n.js';
import { applyBranding } from '/shared/theme.js';
import { devLogin } from '/shared/devlogin.js';
import { createIcon } from '/shared/icons.js';
import { formatDate, formatDateTime, formatTime, formatMoney, formatEnum, formatClaimNumber } from '/shared/format.js';
import { consumePersonaToken, claimantHint, clearSession, readSession } from '/shared/personas.js';
import { registerClaimantStrings, localText } from './strings.js';
import { createIntakeFlow } from './flow.js';
import { createChat } from './chat.js';
import { createStatusPoller, buildTimeline, DEFAULT_INTERVAL_MS } from './status.js';
import { createUploader, KINDS, MAX_BYTES, ACCEPT_ATTR } from './upload.js';
import { h, buildInput, renderStages } from './view.js';
import { fetchPolicyVehicles, errorFor } from './structured.js';
import { STAGES, stageNumber, segmentFills, displayAnswer, reviewRows, vehicleCard, nextStepKey } from './present.js';

try { await import('/shared/components/index.js'); } catch { /* kit components are optional; fallbacks render */ }
try { await import('/shared/components/demo-bar.js'); } catch { /* the demo bar is optional and renders only in dev mode */ }

const TENANTS = [
  { id: 'aurelia-mutual', name: 'Aurelia Mutual' },
  { id: 'kestrel-point', name: 'Kestrel Point' }
];
const LS_LANG = 'fnol.claimant.lang';
const LS_TENANT = 'fnol.claimant.tenant';
const $ = (id) => document.getElementById(id);
const main = $('main');
const shell = $('shell');
const frame = $('cl');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } }
};
const session = {
  get() { try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage; } catch { return undefined; } }
};

registerClaimantStrings(registerStrings);
// S5-WFL-04 holder check strings (kept here: strings.js belongs to another ticket).
registerStrings('en', {
  'claimant.holder.heading': 'Confirm your policy',
  'claimant.holder.lastName': 'Last name on the policy',
  'claimant.holder.zip': 'ZIP code where the vehicle is kept or mail is sent',
  'claimant.holder.submit': 'Find my vehicles',
  'claimant.holder.failed': 'We could not confirm that policy with those details. Check them and try again, or continue without choosing a vehicle.',
  'claimant.holder.zipInvalid': 'Enter a 5-digit ZIP code.',
});
registerStrings('es', {
  'claimant.holder.heading': 'Confirme su póliza',
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
const app = { policyNumber: '', vehicles: [], pickedUnit: null, draft: null, tenant: null, config: null, mode: 'guided', lob: null, lossType: null, flow: null, chat: null, poller: null, uploader: null, uploaderClaim: null, claim: null, unsubs: [], view: 'boot', sub: null, answers: new Map(), hint: null, persona: null, holder: { failed: false, busy: false } };

const fmt = { date: (v) => formatDate(v), dateTime: (v) => formatDateTime(v), money: (v) => formatMoney(v), enumLabel: (v) => formatEnum(v) };
const icon = (name, size = 20) => createIcon(name, { size });
const announce = (msg) => { const live = $('live'); live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); };
const teardown = () => { app.unsubs.forEach((u) => u()); app.unsubs = []; app.poller?.stop(); app.poller = null; };
const finePointer = () => { try { return globalThis.matchMedia?.('(pointer: fine)').matches !== false; } catch { return true; } };
const demoBarActive = () => globalThis.__FNOL_DEV__ === true;

/** Replace the page body and tag the frame so CSS can adapt the layout per screen. */
function render(view, ...nodes) {
  app.view = view;
  frame.dataset.view = view;
  main.replaceChildren(...nodes.flat().filter(Boolean));
}
const focusTitle = () => { const el = $('view-title'); if (el) el.focus({ preventScroll: false }); };

function pickTenant() {
  const fromUrl = new URLSearchParams(location.search).get('tenant');
  const demo = readSession(session.get());
  const ok = (id) => TENANTS.some((x) => x.id === id);
  return [fromUrl, demo?.tenantId, store.get(LS_TENANT)].find(ok) ?? TENANTS[0].id;
}

function applyLocale(loc) {
  setLocale(loc);
  document.documentElement.lang = loc;
  store.set(LS_LANG, loc);
  chrome();
}

/** Shell attributes, skip link, tenant and language pickers. */
function chrome() {
  document.title = t('claimant.title');
  $('skip').textContent = t('claimant.skip');
  $('tenant-label').textContent = t('claimant.tenant.label');
  $('lang-label').textContent = t('claimant.lang.label');
  shell.setAttribute('product', t('claimant.brand.product'));
  $('tenant-wrap').hidden = demoBarActive(); // the demo bar owns tenant switching when it is present
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
  shell.setAttribute('tenant-name', cfg?.displayName ?? '');
  const url = cfg?.branding?.logoUrl;
  if (url && /^\/[A-Za-z0-9._/-]+$/.test(url) && !url.includes('..')) shell.setAttribute('logo', url); else shell.removeAttribute('logo');
  if (app.persona?.displayName) { shell.setAttribute('user-name', app.persona.displayName); shell.setAttribute('user-role', 'claimant'); } else { shell.removeAttribute('user-name'); shell.removeAttribute('user-role'); }
}

// ---------------------------------------------------------------- shared pieces
const card = (cls, ...kids) => h('section', { class: `cl-card ${cls ?? ''}`.trim() }, ...kids);

function cardHead(iconName, eyebrow, title, { titleId, level = 'h2', tabindex } = {}) {
  return h('div', { class: 'cl-cardhead' },
    h('span', { class: 'cl-cardicon', 'aria-hidden': 'true' }, icon(iconName, 22)),
    h('div', {}, eyebrow ? h('p', { class: 'cl-eyebrow', text: eyebrow }) : null, h(level, { class: 'cl-title', id: titleId, tabindex, text: title })));
}

/** "Step 2 of 4 / Questions" plus four segments; the questions segment follows the server's progress. */
function progressHeader(stage, s) {
  const p = s?.progress ?? {};
  const fills = segmentFills(stage, p.percent ?? 0);
  const overall = Math.round(fills.reduce((a, b) => a + b, 0) / STAGES.length);
  const sub = stage === 'questions' && s ? t('claimant.guided.progress', { answered: p.answered ?? 0, remaining: p.requiredRemaining ?? 0 }) : '';
  return h('div', { class: 'cl-progress' },
    h('p', { class: 'cl-progress-label' }, h('span', { text: t('claimant.stage.label', { n: stageNumber(stage), total: STAGES.length }) }), h('strong', { text: t(`claimant.stage.${stage}`) })),
    h('div', { class: 'cl-seg', role: 'progressbar', 'aria-label': t('claimant.progress.label'), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': overall, 'aria-valuetext': [t('claimant.stage.label', { n: stageNumber(stage), total: STAGES.length }), t(`claimant.stage.${stage}`), sub].filter(Boolean).join(', ') },
      fills.map((f, i) => h('span', { class: `cl-seg-part${f === 100 ? ' full' : ''}${STAGES[i] === stage ? ' on' : ''}` }, h('span', { class: 'cl-seg-fill', style: `width:${f}%` })))),
    sub ? h('p', { class: 'cl-progress-sub', text: sub }) : null);
}

const primaryBtn = (text, attrs = {}, iconName = 'arrow-right') => h('button', { class: 'fx-btn lg cl-primary', type: 'button', ...attrs }, text, iconName ? icon(iconName, 18) : null);

// ---------------------------------------------------------------- views
function showUnavailable(retry) {
  app.poller?.stop();
  const btn = h('button', { class: 'fx-btn lg', type: 'button', onclick: retry }, icon('refresh', 18), t('claimant.unavailable.retry'));
  render('unavailable', h('section', { class: 'cl-card cl-alert', role: 'alert' },
    h('span', { class: 'cl-bigicon warn', 'aria-hidden': 'true' }, icon('alert-triangle', 28)),
    h('h1', { id: 'view-title', class: 'cl-title', tabindex: '-1', text: t('claimant.unavailable.title') }),
    h('p', { class: 'muted', text: t('claimant.unavailable.body') }),
    btn));
  announce(t('claimant.unavailable.title'));
  focusTitle();
}

async function boot() {
  teardown();
  app.view = 'boot';
  frame.dataset.view = 'boot';
  main.replaceChildren(h('p', { class: 'cl-loading', text: t('claimant.loading') }));
  app.hint = null; app.persona = null;
  try {
    const demo = consumePersonaToken('/', session.get());
    if (demo && demo.tenantId === app.tenant) {
      token = demo.token; app.persona = demo.persona;
      app.hint = claimantHint(session.get());
    } else {
      const login = await devLogin(api, { tenant: app.tenant, role: 'claimant' });
      token = login.token;
    }
    app.config = await api.get('/config/public');
  } catch (err) {
    token = null;
    return showUnavailable(boot);
  }
  setBrand(app.config);
  const stored = store.get(LS_LANG);
  const loc = stored && (app.config.locales ?? ['en']).includes(stored) ? stored : 'en';
  applyLocale(loc);
  if (app.hint?.policyNumber && !app.policyNumber) app.policyNumber = app.hint.policyNumber;
  showWelcome();
}

function enabledLobs() { return (app.config?.lobs ?? []).filter((l) => l.enabled); }

/** Welcome: tenant brand, what to expect, one clear call to action. */
function showWelcome() {
  teardown();
  const name = app.config?.displayName ?? '';
  const expect = [['chat', 'expect1'], ['shield-check', 'expect2'], ['activity', 'expect3']];
  const start = primaryBtn(t('claimant.welcome.cta'), { id: 'welcome-start', onclick: () => showStart() });
  start.classList.add('cl-cta');
  render('welcome',
    h('section', { class: 'cl-hero' },
      h('p', { class: 'cl-hero-eyebrow' }, icon('claim', 18), name || t('claimant.welcome.eyebrow')),
      h('h1', { id: 'view-title', tabindex: '-1', text: t('claimant.welcome.title') }),
      h('p', { class: 'cl-hero-lede', text: t('claimant.welcome.lede') }),
      h('div', { class: 'cl-hero-actions' }, start, h('span', { class: 'cl-hero-meta' }, icon('clock', 16), t('claimant.welcome.time')))),
    h('div', { class: 'cl-welcome-side' },
      card('', h('h2', { class: 'cl-title', text: t('claimant.welcome.expect') }),
        h('ol', { class: 'cl-expect' }, expect.map(([ic, k], i) => h('li', {},
          h('span', { class: 'cl-cardicon', 'aria-hidden': 'true' }, icon(ic, 20)),
          h('div', {}, h('strong', { text: `${i + 1}. ${t(`claimant.welcome.${k}.title`)}` }), h('p', { class: 'muted', text: t(`claimant.welcome.${k}.body`) })))))),
      h('div', { class: 'cl-note warn' }, icon('alert-triangle', 20), h('p', { text: t('claimant.welcome.emergency') })),
      h('p', { class: 'cl-handy muted' }, icon('info', 16), t('claimant.welcome.handy'))));
  focusTitle();
}

/** Step 1: line of business, loss type, optional policy number, answer mode. */
function showStart() {
  teardown();
  const lobs = enabledLobs();
  const locale = getLocale();
  if (!lobs.length) {
    render('start', progressHeader('details'), card('', h('h1', { id: 'view-title', class: 'cl-title', tabindex: '-1', text: t('claimant.start.heading') }), h('p', { text: t('claimant.start.noLobs') })));
    return focusTitle();
  }
  app.lob ??= lobs[0].id;
  if (!lobs.some((l) => l.id === app.lob)) app.lob = lobs[0].id;
  const optCard = (input, title, help) => h('label', { class: 'cl-opt' }, input, h('span', { class: 'cl-opt-text' }, title, help ? h('small', { text: help }) : null));
  // Loss type is asked first: it selects the tenant question set (e.g. auto glass). Re-rendered when the line changes.
  const lossFs = h('fieldset', { id: 'loss-fs', class: 'cl-qfield' });
  const renderLoss = () => {
    const types = lobs.find((l) => l.id === app.lob)?.lossTypes ?? [];
    if (!types.some((x) => x.id === app.lossType)) app.lossType = types[0]?.id ?? null;
    lossFs.hidden = !types.length;
    lossFs.replaceChildren(h('legend', { class: 'cl-qlabel', text: t('claimant.start.lossType') }), h('p', { class: 'help', text: t('claimant.start.lossTypeHelp') }),
      h('div', { class: 'cl-opts' }, types.map((x) => optCard(h('input', { type: 'radio', name: 'lossType', value: x.id, checked: x.id === app.lossType || null, onchange: () => { app.lossType = x.id; } }), localText(x.label, locale) || x.id))));
  };
  const lobFs = h('fieldset', { class: 'cl-qfield' }, h('legend', { class: 'cl-qlabel', text: t('claimant.start.lob') }), h('p', { class: 'help', text: t('claimant.start.lobHelp') }),
    h('div', { class: 'cl-opts' }, lobs.map((l) => optCard(h('input', { type: 'radio', name: 'lob', value: l.id, checked: l.id === app.lob || null, onchange: () => { app.lob = l.id; renderLoss(); } }), localText(l.label, locale) || l.id))));
  renderLoss();
  const modeFs = h('fieldset', { class: 'cl-qfield' }, h('legend', { class: 'cl-qlabel', text: t('claimant.start.mode') }), h('p', { class: 'help', text: t('claimant.start.modeHelp') }),
    h('div', { class: 'cl-opts two' }, [['guided', 'claimant.start.guided', 'claimant.start.guidedHelp', 'list'], ['chat', 'claimant.start.chat', 'claimant.start.chatHelp', 'chat']].map(([v, a, b]) =>
      optCard(h('input', { type: 'radio', name: 'mode', value: v, checked: app.mode === v || null, onchange: () => { app.mode = v; } }), t(a), t(b)))));
  const err = h('p', { class: 'field-error', id: 'start-error', role: 'alert' });
  const policyIn = h('input', { type: 'text', id: 'policy-number', name: 'policyNumber', autocomplete: 'off', 'aria-describedby': 'policy-number-help', value: app.policyNumber || null, onchange: (e) => { app.policyNumber = e.target.value.trim(); } });
  const policyBox = h('div', { class: 'cl-qfield' }, h('label', { for: 'policy-number', class: 'cl-qlabel', text: t('claimant.start.policy') }), h('p', { class: 'help', id: 'policy-number-help', text: t('claimant.start.policyHelp') }), policyIn);
  const form = h('form', { class: 'cl-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); app.policyNumber = policyIn.value.trim(); startSession(); } },
    card('', h('h1', { id: 'view-title', class: 'cl-title cl-title-lg', tabindex: '-1', text: t('claimant.start.heading') }), h('p', { class: 'muted', text: t('claimant.start.intro') }), lobFs, lossFs, policyBox, modeFs, err),
    h('div', { class: 'cl-actions' },
      h('button', { class: 'fx-btn lg secondary cl-back', type: 'button', onclick: () => showWelcome() }, icon('chevron-left', 18), t('claimant.back')),
      h('button', { class: 'fx-btn lg cl-primary', type: 'submit' }, t('claimant.start.go'), icon('arrow-right', 18))));
  app.startError = err;
  render('start', progressHeader('details'), form);
  focusTitle();
}

async function startSession() {
  const flow = createIntakeFlow({ api });
  app.flow = flow;
  app.chat = app.mode === 'chat' ? createChat({ flow, t: (k, p) => t(k, p), locale: getLocale }) : null;
  teardown();
  app.unsubs.push(flow.subscribe(onFlow));
  app.vehicles = []; app.pickedUnit = null; app.draft = null; app.answers = new Map(); app.holder = { failed: false, busy: false };
  app.sub = app.policyNumber && app.mode === 'guided' ? 'holder' : null;
  await flow.start({ lob: app.lob, lossType: app.lossType ?? undefined, locale: getLocale(), policyNumber: app.policyNumber || undefined });
}

/** Holder check (S5-WFL-04): last name + ZIP, then the vehicles. Values live only in the inputs and the request. */
async function verifyHolder(lastName, zip) {
  app.holder = { failed: false, busy: true };
  showGuided(app.flow.state);
  const rows = await fetchPolicyVehicles(api, app.flow.state.sessionId, { lastName, zip });
  app.vehicles = rows;
  app.holder = { failed: !rows.length, busy: false };
  if (rows.length) app.sub = 'vehicle';
  showGuided(app.flow.state);
  if (!rows.length) { announce(t('claimant.holder.failed')); $('holder-last-name')?.focus(); }
}

function holderStep(s) {
  const zipErr = h('p', { id: 'holder-zip-error', class: 'field-error', role: 'alert', hidden: true, text: t('claimant.holder.zipInvalid') });
  const failed = h('p', { id: 'holder-error', class: 'field-error', role: 'alert', hidden: app.holder?.failed ? null : true, text: app.holder?.failed ? t('claimant.holder.failed') : '' });
  const last = h('input', { id: 'holder-last-name', name: 'holder_last_name', type: 'text', autocomplete: 'family-name', value: app.hint?.lastName || null });
  const zip = h('input', { id: 'holder-zip', name: 'holder_zip', type: 'text', inputmode: 'numeric', autocomplete: 'postal-code', maxlength: '10', value: app.hint?.zip || null, 'aria-describedby': 'holder-zip-error' });
  // A group, not a <form>: the question form stays the only form in main.
  const go = () => {
    zipErr.hidden = /^\d{5}(-?\d{4})?$/.test(zip.value.trim());
    zip.toggleAttribute('aria-invalid', !zipErr.hidden);
    if (!zipErr.hidden) return zip.focus();
    verifyHolder(last.value, zip.value);
  };
  const enter = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  last.addEventListener('keydown', enter); zip.addEventListener('keydown', enter);
  const busy = !!app.holder?.busy;
  return [progressHeader('questions', s),
    h('div', { id: 'holder-check', class: 'cl-card', role: 'group', 'aria-labelledby': 'view-title' },
      cardHead('shield-check', t('claimant.stage.questions'), t('claimant.holder.heading'), { titleId: 'view-title', level: 'h1', tabindex: '-1' }),
      h('p', { class: 'muted', text: t('claimant.holder.intro') }),
      h('div', { class: 'cl-grid2' },
        h('div', { class: 'cl-qfield' }, h('label', { for: 'holder-last-name', text: t('claimant.holder.lastName') }), last),
        h('div', { class: 'cl-qfield' }, h('label', { for: 'holder-zip', text: t('claimant.holder.zip') }), zip, zipErr)),
      failed,
      h('div', { class: 'cl-actions inline' },
        primaryBtn(t('claimant.holder.submit'), { id: 'holder-go', onclick: go, disabled: busy || null, 'aria-busy': busy ? 'true' : null }),
        h('button', { class: 'fx-btn lg ghost', type: 'button', id: 'holder-skip', onclick: () => { app.sub = null; showGuided(app.flow.state); } }, t('claimant.holder.skip'))))];
}

/** Insured vehicle: policy vehicles as large selectable cards. Picking one saves it to the session straight away. */
function vehicleStep(s) {
  const failure = s.insuredVehicleError;
  const saved = s.insuredVehicleSent && app.pickedUnit;
  const items = app.vehicles.map((v) => {
    const c = vehicleCard(v);
    const input = h('input', { type: 'radio', name: 'insured_vehicle', value: v.unitId, checked: v.unitId === app.pickedUnit || null, onchange: () => {
      app.pickedUnit = v.unitId; app.refocusPicker = true;
      app.answers.set('insured_vehicle', { label: t('claimant.review.vehicle'), text: c.title });
      app.flow.setInsuredVehicle(v.answer);
    } });
    return h('label', { class: 'cl-vehicle' }, input,
      h('span', { class: 'cl-vehicle-icon', 'aria-hidden': 'true' }, icon('car', 24)),
      h('span', { class: 'cl-vehicle-text' }, h('strong', { text: c.title }), c.last4 ? h('small', { class: 'cl-mono', text: t('claimant.vehicle.vin', { last4: c.last4 }) }) : null),
      h('span', { class: 'cl-vehicle-check', 'aria-hidden': 'true' }, icon('check', 16)));
  });
  const err = h('p', { id: 'vehicle-error', class: 'field-error', role: 'alert', hidden: failure ? null : true, text: failure ? t('claimant.sf.vehicle.failed', { message: failure }) : '' });
  return [progressHeader('questions', s),
    h('div', { id: 'vehicle-pick', class: 'cl-card' },
      cardHead('car', t('claimant.stage.questions'), t('claimant.vehicle.heading'), { titleId: 'view-title', level: 'h1', tabindex: '-1' }),
      h('fieldset', { class: 'cl-qfield' }, h('legend', { class: 'sr-only', text: t('claimant.sf.vehicle.label') }), h('p', { class: 'help', text: t('claimant.vehicle.help') }),
        h('div', { class: 'cl-vehicles' }, items)),
      saved ? h('p', { class: 'cl-saved', role: 'status' }, icon('check-circle', 16), t('claimant.vehicle.saved')) : null,
      err),
    h('div', { class: 'cl-actions' },
      primaryBtn(t('claimant.vehicle.continue'), { id: 'vehicle-continue', disabled: app.pickedUnit ? null : true, onclick: () => { app.sub = null; showGuided(app.flow.state); } }))];
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

function disclosures(s) {
  const list = s.disclosures ?? [];
  if (!list.length) return [];
  return [h('div', { class: 'cl-note' }, icon('info', 20), h('div', {}, list.map((d) => h('p', { class: 'disclosure', text: d }))))];
}

/** Review: every answer given, in order, then the submit action. */
function reviewStep(s, { chat = false } = {}) {
  const rows = chat ? [] : reviewRows(app.answers);
  const submit = primaryBtn(t('claimant.review.submit'), { id: 'submit-claim', 'aria-busy': s.busy ? 'true' : null, disabled: s.busy || null, onclick: (e) => {
    e.currentTarget.disabled = true; e.currentTarget.setAttribute('aria-busy', 'true');
    app.flow.submit();
  } }, 'check');
  const submitError = s.error ? h('p', { class: 'field-error', role: 'alert' }, t('claimant.error.generic', { message: s.error.message })) : null;
  return card('cl-review',
    cardHead('claim', t('claimant.review.eyebrow'), t('claimant.review.title'), { titleId: 'review-title', tabindex: '-1' }),
    h('p', { class: 'muted', text: chat ? t('claimant.review.body') : t('claimant.review.lede') }),
    ...disclosures(s),
    rows.length ? h('div', { class: 'cl-rows-wrap' }, h('h3', { class: 'cl-subhead', text: t('claimant.review.answers') }),
      h('dl', { class: 'cl-rows' }, rows.map((r) => h('div', { class: 'cl-row' }, h('dt', { text: r.label }), h('dd', { class: r.skipped ? 'muted' : '', text: r.skipped ? t('claimant.review.skipped') : r.text }))))) : null,
    h('p', { class: 'cl-fine muted', text: t('claimant.review.note') }),
    submitError,
    h('div', { class: 'cl-actions inline' }, submit));
}

/** Guided mode: exactly the question the server returned, one at a time. */
function showGuided(s) {
  if (app.sub === 'holder') { render('guided', holderStep(s)); return focusTitle(); }
  if (app.sub === 'vehicle') {
    render('guided', vehicleStep(s));
    if (app.refocusPicker) { app.refocusPicker = false; document.querySelector('input[name="insured_vehicle"]:checked')?.focus(); } else focusTitle();
    return;
  }
  if (s.question) return questionStep(s);
  if (s.phase === 'ready') {
    render('guided', progressHeader('review', s), reviewStep(s));
    return $('review-title')?.focus();
  }
}

function questionStep(s) {
  const q = s.question;
  const errId = 'q-error';
  const draft = app.draft?.qid === q.id ? app.draft.raw : undefined;
  const input = buildInput(q, { locale: getLocale(), t, errorId: s.errors.length ? errId : null, initial: draft });
  const own = errorFor(s.errors, q.id);
  const errs = s.errors.length ? h('p', { class: 'field-error', id: errId, role: 'alert' }, h('span', { class: 'cl-err-icon' }, icon('alert-circle', 16)), h('span', { text: own || s.errors.map((e) => e.message).join(' ') })) : null;
  const form = h('form', { class: 'cl-form', novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    if (input.raw) app.draft = { qid: q.id, raw: input.raw() };
    const v = input.get();
    if (!input.check()) return;
    if (v === undefined) {
      if (q.required) { input.setError(t('claimant.guided.required')); return input.focus(); }
      app.answers.delete(q.id);
      return app.flow.answer(q.id, null);
    }
    app.answers.set(q.id, { label: localText(q.text, getLocale()), text: displayAnswer(q, v, { t, locale: getLocale(), fmt }) });
    app.flow.answer(q.id, v);
  } },
    card('cl-q', h('p', { class: 'cl-eyebrow', text: t('claimant.guided.question', { n: (s.progress?.answered ?? 0) + 1 }) }), input.el, errs),
    h('div', { class: 'cl-actions' },
      !q.required ? h('button', { class: 'fx-btn lg secondary', type: 'button', disabled: s.busy || null, onclick: () => { app.answers.delete(q.id); app.flow.answer(q.id, null); } }, t('claimant.guided.skip')) : null,
      h('button', { class: 'fx-btn lg cl-primary', type: 'submit', disabled: s.busy || null }, t('claimant.guided.next'), icon('arrow-right', 18))));
  render('guided', progressHeader('questions', s), h('h1', { id: 'view-title', class: 'sr-only', tabindex: '-1', text: t('claimant.title') }), ...disclosures(s), form);
  if (q.id !== lastQid) announce(localText(q.text, getLocale()));
  if (finePointer()) input.focus(); else focusTitle();
}

/** Conversational mode. */
function showChat(s) {
  const first = app.view !== 'chat';
  if (first) {
    const log = h('ol', { class: 'log', id: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': t('claimant.chat.log'), tabindex: '0' });
    const input = h('textarea', { id: 'chat-input', rows: 2, 'aria-label': t('claimant.chat.input'), onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
    const send = () => { const v = input.value; if (!v.trim()) return; input.value = ''; app.chat.sendText(v).then(() => input.focus()); };
    const form = h('form', { class: 'cl-chatform', onsubmit: (e) => { e.preventDefault(); send(); } }, h('label', { for: 'chat-input', class: 'sr-only', text: t('claimant.chat.input') }), input,
      h('button', { class: 'fx-btn lg cl-primary', type: 'submit' }, t('claimant.chat.send'), icon('arrow-right', 18)));
    render('chat', progressHeader('questions', s), card('cl-chat', h('h1', { id: 'view-title', class: 'cl-title', tabindex: '-1', text: t('claimant.chat.heading') }), log, h('div', { id: 'chat-form' }, form)), h('div', { id: 'chat-submit' }));
    app.unsubs.push(app.chat.subscribe(renderLog));
    input.focus();
  } else {
    const stage = s.phase === 'ready' ? 'review' : 'questions';
    main.querySelector('.cl-progress')?.replaceWith(progressHeader(stage, s));
  }
  const submitSlot = $('chat-submit');
  if (submitSlot) {
    submitSlot.replaceChildren(s.phase === 'ready' ? reviewStep(s, { chat: true }) : '');
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
      const saveBtn = h('button', { class: 'fx-btn small secondary', type: 'button', hidden: true, onclick: () => app.chat.editSuggestion(m.questionId, edit.value) }, t('claimant.chat.save'));
      const editBtn = h('button', { class: 'fx-btn small secondary', type: 'button', onclick: () => { edit.hidden = false; saveBtn.hidden = false; editBtn.hidden = true; edit.focus(); } }, t('claimant.chat.edit'));
      li.append(h('div', { class: 'cl-actions inline' }, h('button', { class: 'fx-btn small', type: 'button', onclick: () => app.chat.confirmSuggestion(m.questionId) }, t('claimant.chat.confirm')), editBtn), edit, saveBtn);
    } else li.append(h('span', { class: 'ai-note', text: t('claimant.chat.confirmed') }));
  }
  return li;
}

// ---------------------------------------------------------------- after submit
function claimBadge(status) {
  const b = document.createElement('fx-badge');
  b.setAttribute('status', status); b.setAttribute('kind', 'claim'); b.setAttribute('label', t(`claimant.status.${status}`));
  return b;
}

function showSubmitted(claim) {
  teardown();
  app.claim = claim;
  if (app.uploaderClaim !== claim.id) { app.uploader = createUploader({ api, claimId: claim.id }); app.uploaderClaim = claim.id; }
  const number = formatClaimNumber(claim.claimNumber);
  const filesList = h('ul', { class: 'cl-files', 'aria-live': 'polite' });
  const kind = h('select', { id: 'ev-kind' }, KINDS.map((k) => h('option', { value: k, text: t(`claimant.evidence.kind.${k}`) })));
  const picker = h('input', { type: 'file', id: 'ev-files', class: 'sr-only', multiple: true, accept: ACCEPT_ATTR, onchange: async () => {
    const files = [...picker.files]; picker.value = '';
    for (const f of files) await app.uploader.add(f, kind.value);
  } });
  app.unsubs.push(app.uploader.subscribe((items) => {
    filesList.replaceChildren(...items.map((i) => {
      const ok = i.status === 'done'; const busy = i.status === 'uploading';
      const text = busy ? t('claimant.evidence.uploading', { name: i.name })
        : ok ? t('claimant.evidence.done', { name: i.name })
        : i.code === 'tooLarge' ? t('claimant.evidence.tooLarge', { name: i.name, max: MAX_BYTES / 1048576 })
        : i.code === 'badType' ? t('claimant.evidence.badType', { name: i.name })
        : t('claimant.evidence.failed', { name: i.name });
      return h('li', { class: ok ? 'ok' : busy ? 'busy' : 'bad' }, h('span', { class: 'cl-fileicon', 'aria-hidden': 'true' }, icon(ok ? 'check-circle' : busy ? 'clock' : 'alert-circle', 18)), h('span', { text }),
        i.status === 'error' ? h('button', { class: 'fx-btn small secondary', type: 'button', onclick: () => app.uploader.retry(i.id) }, t('claimant.evidence.retry')) : null);
    }));
  }));

  const statusBox = h('div', { id: 'status-box' });
  const badgeSlot = h('span', { class: 'cl-badge-slot' }, claimBadge(claim.status));
  const whenSlot = h('span', { class: 'muted' });
  const note = h('p', { class: 'cl-livenote muted', role: 'status', id: 'status-note' });
  const refresh = h('button', { class: 'fx-btn small secondary', type: 'button', onclick: () => app.poller?.refresh() }, icon('refresh', 16), t('claimant.status.refresh'));
  const copyBtn = h('button', { class: 'fx-btn small secondary', type: 'button', id: 'copy-claim', onclick: async () => {
    try { await navigator.clipboard.writeText(number); copyBtn.lastChild.textContent = t('claimant.submitted.copied'); announce(t('claimant.submitted.copied')); } catch { /* clipboard may be blocked */ }
  } }, icon('file', 16), h('span', { text: t('claimant.submitted.copy') }));

  render('submitted', progressHeader('done'),
    card('cl-success',
      h('span', { class: 'cl-bigicon ok', 'aria-hidden': 'true' }, icon('check', 32)),
      h('h1', { id: 'view-title', class: 'cl-title cl-title-lg', tabindex: '-1', text: t('claimant.submitted.heading') }),
      h('p', { class: 'muted', text: t('claimant.submitted.lede') }),
      h('div', { class: 'cl-claimno' }, h('div', {}, h('p', { class: 'cl-eyebrow', text: t('claimant.submitted.number') }), h('p', { class: 'claim-number', id: 'claim-number', text: number })), copyBtn),
      h('p', { class: 'cl-claimmeta' }, badgeSlot, whenSlot)),
    card('', h('div', { class: 'cl-cardhead' }, h('span', { class: 'cl-cardicon', 'aria-hidden': 'true' }, icon('activity', 22)), h('div', {}, h('h2', { class: 'cl-title', text: t('claimant.next.heading') }), h('p', { class: 'muted cl-sub', text: t('claimant.status.live') }))),
      statusBox, note, h('div', { class: 'cl-actions inline' }, refresh)),
    card('', h('div', { class: 'cl-cardhead' }, h('span', { class: 'cl-cardicon', 'aria-hidden': 'true' }, icon('camera', 22)), h('div', {}, h('h2', { class: 'cl-title', text: t('claimant.evidence.heading') }), h('p', { class: 'muted cl-sub', text: t('claimant.evidence.help', { max: MAX_BYTES / 1048576 }) }))),
      h('div', { class: 'cl-qfield' }, h('label', { for: 'ev-kind', text: t('claimant.evidence.kind') }), kind),
      h('label', { class: 'cl-drop', for: 'ev-files' }, picker, icon('upload', 24), h('span', { text: t('claimant.evidence.tap') }), h('small', { text: t('claimant.evidence.choose') })),
      filesList));
  announce(`${t('claimant.submitted.heading')} ${number}`);
  focusTitle();

  const paint = (c) => {
    statusBox.replaceChildren(renderStages(buildTimeline(c, t), t, { icon, time: (v) => formatDateTime(v), next: (id) => t(nextStepKey(id)) }));
    badgeSlot.replaceChildren(claimBadge(c.status));
    const reported = c.reportedAt ?? claim.reportedAt;
    whenSlot.textContent = reported ? t('claimant.submitted.reportedOn', { date: formatDateTime(reported) }) : '';
  };
  paint(claim);
  const poller = createStatusPoller({ api, claimId: claim.id, intervalMs: DEFAULT_INTERVAL_MS, isHidden: () => document.hidden });
  app.poller = poller;
  let lastStatus = claim.status;
  app.unsubs.push(poller.subscribe((s) => {
    if (s.claim) {
      paint(s.claim);
      if (s.status !== lastStatus) { lastStatus = s.status; announce(t(`claimant.status.${s.status}`)); }
    }
    note.textContent = s.final ? t('claimant.status.final', { status: t(`claimant.status.${s.status}`) })
      : s.stale ? t('claimant.status.stale')
      : s.paused ? t('claimant.status.paused')
      : s.checkedAt ? t('claimant.status.updated', { time: formatTime(s.checkedAt) }) : '';
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
  app.lob = null; app.config = null; app.policyNumber = '';
  boot();
});
$('lang-picker').addEventListener('change', (e) => {
  applyLocale(e.target.value);
  if (app.view === 'welcome') showWelcome();
  else if (app.view === 'start') showStart();
  else if (app.view === 'guided' && app.flow) { lastQid = null; showGuided(app.flow.state); }
  else if (app.view === 'chat') { app.view = 'chat-rebuild'; showChat(app.flow.state); }
  else if (app.view === 'submitted' && app.claim) showSubmitted(app.claim);
});
// Signing out of a demo persona clears the demo session and starts over as an anonymous claimant.
shell.addEventListener('fx-signout', () => {
  clearSession(session.get());
  app.persona = null; app.hint = null; app.policyNumber = '';
  boot();
});

app.tenant = pickTenant();
store.set(LS_TENANT, app.tenant);
chrome();
boot();
