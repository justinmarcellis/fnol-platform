// Pure HTML builders for the admin console. Every dynamic value is escaped.
import {
  configLocales, describeCondition, errorsFor, errorsUnder, getAt, i18nGet, toJsonText, toPointer, flattenKpis,
} from './config-model.js';

export const TABS = [
  ['branding', 'Branding'], ['lobs', 'Lines of business'], ['locales', 'Locales'], ['questions', 'Questions'],
  ['rules', 'Rules'], ['timers', 'Timers'], ['webhooks', 'Webhooks'], ['history', 'Version history'], ['kpis', 'KPIs'],
];
export const QUESTION_TYPES = ['text', 'longtext', 'number', 'currency', 'boolean', 'date', 'time', 'datetime', 'select', 'multiselect', 'address', 'location', 'phone', 'email', 'vin', 'party', 'vehicle', 'media', 'disclosure'];
export const RULE_STAGES = ['intake', 'triage', 'routing', 'post_routing'];
export const TIMER_KINDS = ['acknowledge', 'contact', 'decide'];
export const TIMER_UNITS = ['hours', 'days', 'business_days'];
export const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];

/** Escape text for HTML content and attributes. @param {any} v */
export function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Stable element id for a pointer (and optional suffix). */
export const fieldId = (pointer, suffix = '') => `f${String(pointer).replace(/[^a-zA-Z0-9]+/g, '-')}${suffix ? `-${suffix}` : ''}`;

/**
 * One labelled control.
 * @param {{pointer:string, label:string, kind?:string, value?:any, options?:string[], hint?:string, errors?:Array<{message:string}>, rows?:number, locale?:string, attrs?:string}} p
 */
export function fieldHtml(p) {
  const kind = p.kind ?? 'text';
  const id = fieldId(p.pointer, p.locale);
  const errs = p.errors ?? [];
  const invalid = errs.length ? ' aria-invalid="true"' : '';
  const desc = [p.hint ? `${id}-hint` : '', errs.length ? `${id}-err` : ''].filter(Boolean).join(' ');
  const base = `id="${id}" data-path="${esc(p.pointer)}" data-kind="${esc(kind)}"${p.locale ? ` data-locale="${esc(p.locale)}"` : ''}${invalid}${desc ? ` aria-describedby="${desc}"` : ''} ${p.attrs ?? ''}`;
  let control;
  if (kind === 'bool') {
    control = `<input type="checkbox" ${base}${p.value ? ' checked' : ''}>`;
    return `<div class="field field-bool">${control} <label for="${id}">${esc(p.label)}</label>${errHtml(id, errs, p.pointer)}</div>`;
  }
  if (kind === 'select') {
    const opts = (p.options ?? []).map((o) => `<option value="${esc(o)}"${o === p.value ? ' selected' : ''}>${esc(o)}</option>`).join('');
    control = `<select ${base}>${p.value === undefined || p.value === '' ? '<option value=""></option>' : ''}${opts}</select>`;
  } else if (kind === 'json') {
    control = `<textarea ${base} rows="${p.rows ?? 6}" spellcheck="false">${esc(p.rawText !== undefined ? p.rawText : toJsonText(p.value))}</textarea>`;
  } else if (kind === 'csv') {
    control = `<input type="text" ${base} value="${esc(Array.isArray(p.value) ? p.value.join(', ') : '')}">`;
  } else {
    const type = kind === 'number' || kind === 'int' ? 'number' : 'text';
    control = `<input type="${type}" ${base} value="${esc(p.value ?? '')}">`;
  }
  const hint = p.hint ? `<p class="muted" id="${id}-hint">${esc(p.hint)}</p>` : '';
  return `<div class="field"><label for="${id}">${esc(p.label)}</label>${control}${hint}${errHtml(id, errs, p.pointer)}</div>`;
}

function errHtml(id, errs, pointer) {
  if (!errs.length) return '';
  return `<p class="err" id="${id}-err" data-error-for="${esc(pointer)}">${errs.map((e) => esc(e.message)).join(' ')}</p>`;
}

/** Collect errors for a pointer: schema/semantic report plus local JSON/number parse errors. */
function errsFor(ctx, pointer, deep = false) {
  const out = deep ? errorsUnder(ctx.report, pointer) : errorsFor(ctx.report, pointer);
  const local = ctx.localErrors?.[pointer];
  return local ? [{ message: local }, ...out] : out;
}

/** An I18nText editor: one input per configured locale. */
function i18nField(ctx, pointer, label, opts = {}) {
  const value = getAt(ctx.cfg, pointer);
  const errs = [...errorsUnder(ctx.report, pointer)];
  const inputs = configLocales(ctx.cfg).map((loc) => fieldHtml({
    pointer, label: `${label} (${loc})`, kind: 'i18n', value: i18nGet(value, loc), locale: loc, errors: loc === 'en' ? errs : [], hint: opts.hint,
  })).join('');
  return `<div class="i18n">${inputs}</div>`;
}

const btn = (act, pointer, text, extra = '') => `<button type="button" class="fx-btn secondary small" data-act="${act}" data-path="${esc(pointer)}"${extra}>${esc(text)}</button>`;

function itemControls(listPtr, i, len, noun) {
  return `<div class="item-actions">${btn('up', listPtr, 'Move up', ` data-index="${i}" aria-label="Move ${esc(noun)} ${i + 1} up"${i === 0 ? ' disabled' : ''}`)}${btn('down', listPtr, 'Move down', ` data-index="${i}" aria-label="Move ${esc(noun)} ${i + 1} down"${i === len - 1 ? ' disabled' : ''}`)}${btn('remove', listPtr, 'Remove', ` data-index="${i}" aria-label="Remove ${esc(noun)} ${i + 1}"`)}</div>`;
}

// ---- panels
export function brandingHtml(ctx) {
  const f = (key, label, kind = 'text', hint) => fieldHtml({ pointer: `/branding/${key}`, label, kind, value: getAt(ctx.cfg, `/branding/${key}`), errors: errsFor(ctx, `/branding/${key}`), hint });
  return `<h2 id="h-branding" tabindex="-1">Branding</h2>
<div class="cols">
${fieldHtml({ pointer: '/displayName', label: 'Display name', value: ctx.cfg.displayName, errors: errsFor(ctx, '/displayName') })}
${fieldHtml({ pointer: '/claimNumberPrefix', label: 'Claim number prefix', value: ctx.cfg.claimNumberPrefix, errors: errsFor(ctx, '/claimNumberPrefix'), hint: '2 to 5 capital letters.' })}
${fieldHtml({ pointer: '/timeZone', label: 'Time zone', value: ctx.cfg.timeZone, errors: errsFor(ctx, '/timeZone') })}
${f('primaryColor', 'Primary color', 'text', 'Hex such as #0b5cad.')}
${f('accentColor', 'Accent color', 'text', 'Hex such as #7a3e00.')}
${f('fontFamily', 'Font family')}
${f('logoUrl', 'Logo path')}
${f('supportPhone', 'Support phone')}
${f('supportEmail', 'Support email')}
</div>
${i18nField(ctx, '/branding/legalFooter', 'Legal footer')}
<div class="swatch-row" aria-hidden="true"><span class="swatch" style="background:${esc(ctx.cfg.branding?.primaryColor ?? '#ffffff')}"></span><span class="swatch" style="background:${esc(ctx.cfg.branding?.accentColor ?? '#ffffff')}"></span></div>`;
}

export function lobsHtml(ctx) {
  const lobs = ctx.cfg.lobs ?? [];
  const items = lobs.map((l, i) => {
    const p = `/lobs/${i}`;
    return `<fieldset class="item" data-item="${p}"><legend>Line of business ${i + 1}: ${esc(l.id)}</legend>
${itemControls('/lobs', i, lobs.length, 'line of business')}
<div class="cols">
${fieldHtml({ pointer: `${p}/id`, label: 'Id', value: l.id, errors: errsFor(ctx, `${p}/id`), hint: 'Lowercase letters, digits and underscores.' })}
${fieldHtml({ pointer: `${p}/acordLobCd`, label: 'ACORD LOB code', value: l.acordLobCd, errors: errsFor(ctx, `${p}/acordLobCd`) })}
${fieldHtml({ pointer: `${p}/states`, label: 'States (comma separated)', kind: 'csv', value: l.states, errors: errsFor(ctx, `${p}/states`, true), hint: `Two-letter codes, for example ${US_STATES.slice(0, 3).join(', ')}.` })}
${fieldHtml({ pointer: `${p}/enabled`, label: 'Enabled', kind: 'bool', value: l.enabled, errors: errsFor(ctx, `${p}/enabled`) })}
</div>
${i18nField(ctx, `${p}/label`, 'Label')}
</fieldset>`;
  }).join('');
  return `<h2 id="h-lobs" tabindex="-1">Lines of business</h2>${items}<p>${btn('add', '/lobs', 'Add line of business')}</p>`;
}

export function localesHtml(ctx) {
  return `<h2 id="h-locales" tabindex="-1">Locales</h2>
<p class="muted">Languages offered to claimants. Text fields in the other editors gain one input per locale listed here.</p>
${fieldHtml({ pointer: '/locales', label: 'Locales (comma separated)', kind: 'csv', value: ctx.cfg.locales ?? ['en'], errors: errsFor(ctx, '/locales', true), hint: 'BCP 47 tags such as en, es, fr-CA.' })}`;
}

export function questionsHtml(ctx) {
  const sets = ctx.cfg.questionSets ?? [];
  const si = Math.min(Math.max(ctx.qSet ?? 0, 0), Math.max(sets.length - 1, 0));
  const set = sets[si];
  const picker = `<p><label for="qset-pick">Question set</label> <select id="qset-pick" data-ui="qset">${sets.map((s, i) => `<option value="${i}"${i === si ? ' selected' : ''}>${esc(s.id)} (${esc(s.lob)})</option>`).join('')}</select> ${btn('add', '/questionSets', 'Add question set')}</p>`;
  if (!set) return `<h2 id="h-questions" tabindex="-1">Questions</h2>${picker}<p class="muted">No question sets yet.</p>`;
  const sp = `/questionSets/${si}`;
  const qs = (set.questions ?? []).map((q, i) => {
    const p = `${sp}/questions/${i}`;
    const showIfErr = errsFor(ctx, `${p}/showIf`, true);
    return `<fieldset class="item" data-item="${p}"><legend>Question ${i + 1}: ${esc(q.id)}</legend>
${itemControls(`${sp}/questions`, i, set.questions.length, 'question')}
<div class="cols">
${fieldHtml({ pointer: `${p}/id`, label: 'Id', value: q.id, errors: errsFor(ctx, `${p}/id`), hint: 'Lowercase letters, digits and underscores.' })}
${fieldHtml({ pointer: `${p}/type`, label: 'Type', kind: 'select', options: QUESTION_TYPES, value: q.type, errors: errsFor(ctx, `${p}/type`) })}
${fieldHtml({ pointer: `${p}/order`, label: 'Order', kind: 'int', value: q.order, errors: errsFor(ctx, `${p}/order`) })}
${fieldHtml({ pointer: `${p}/required`, label: 'Required', kind: 'bool', value: q.required, errors: errsFor(ctx, `${p}/required`) })}
</div>
${i18nField(ctx, `${p}/text`, 'Question text')}
${fieldHtml({ pointer: `${p}/showIf`, label: 'Show if (condition JSON, empty = always ask)', kind: 'json', rawText: ctx.rawText?.[`${p}/showIf`], value: q.showIf, errors: showIfErr, rows: 5, hint: `Reads as: ${describeCondition(q.showIf)}` })}
${q.type === 'select' || q.type === 'multiselect' ? fieldHtml({ pointer: `${p}/options`, label: 'Options (JSON list of value and label)', kind: 'json', rawText: ctx.rawText?.[`${p}/options`], value: q.options, errors: errsFor(ctx, `${p}/options`, true), rows: 4 }) : ''}
</fieldset>`;
  }).join('');
  return `<h2 id="h-questions" tabindex="-1">Questions</h2>${picker}
<div class="cols">
${fieldHtml({ pointer: `${sp}/id`, label: 'Set id', value: set.id, errors: errsFor(ctx, `${sp}/id`) })}
${fieldHtml({ pointer: `${sp}/lob`, label: 'Line of business', kind: 'select', options: (ctx.cfg.lobs ?? []).map((l) => l.id), value: set.lob, errors: errsFor(ctx, `${sp}/lob`) })}
${fieldHtml({ pointer: `${sp}/version`, label: 'Set version', kind: 'int', value: set.version, errors: errsFor(ctx, `${sp}/version`) })}
</div>
<p>${btn('remove', '/questionSets', 'Remove this set', ` data-index="${si}"`)}</p>
${qs}<p>${btn('add', `${sp}/questions`, 'Add question')}</p>`;
}

export function rulesHtml(ctx) {
  const rules = ctx.cfg.rules ?? [];
  const ft = ctx.cfg.fastTrack;
  const items = rules.map((r, i) => {
    const p = `/rules/${i}`;
    return `<fieldset class="item" data-item="${p}"><legend>Rule ${i + 1}: ${esc(r.id)}</legend>
${itemControls('/rules', i, rules.length, 'rule')}
<div class="cols">
${fieldHtml({ pointer: `${p}/id`, label: 'Id', value: r.id, errors: errsFor(ctx, `${p}/id`), hint: 'Capitals, digits and dashes, for example RT-INJURY-01.' })}
${fieldHtml({ pointer: `${p}/name`, label: 'Name', value: r.name, errors: errsFor(ctx, `${p}/name`) })}
${fieldHtml({ pointer: `${p}/stage`, label: 'Stage', kind: 'select', options: RULE_STAGES, value: r.stage, errors: errsFor(ctx, `${p}/stage`) })}
${fieldHtml({ pointer: `${p}/priority`, label: 'Priority (lower runs first)', kind: 'int', value: r.priority, errors: errsFor(ctx, `${p}/priority`) })}
${fieldHtml({ pointer: `${p}/enabled`, label: 'Enabled', kind: 'bool', value: r.enabled !== false, errors: errsFor(ctx, `${p}/enabled`) })}
${fieldHtml({ pointer: `${p}/stopOnMatch`, label: 'Stop on match', kind: 'bool', value: r.stopOnMatch === true, errors: errsFor(ctx, `${p}/stopOnMatch`) })}
</div>
${fieldHtml({ pointer: `${p}/when`, label: 'When (condition JSON)', kind: 'json', rawText: ctx.rawText?.[`${p}/when`], value: r.when, errors: errsFor(ctx, `${p}/when`, true), rows: 8, hint: `Reads as: ${describeCondition(r.when)}` })}
${fieldHtml({ pointer: `${p}/then`, label: 'Then (list of actions, JSON)', kind: 'json', rawText: ctx.rawText?.[`${p}/then`], value: r.then, errors: errsFor(ctx, `${p}/then`, true), rows: 6 })}
</fieldset>`;
  }).join('');
  const ftHtml = ft ? `<fieldset><legend>Straight-through processing limits</legend><div class="cols">
${fieldHtml({ pointer: '/fastTrack/enabled', label: 'Fast track enabled', kind: 'bool', value: ft.enabled, errors: errsFor(ctx, '/fastTrack/enabled') })}
${fieldHtml({ pointer: '/fastTrack/maxSeverity', label: 'Maximum severity', kind: 'int', value: ft.maxSeverity, errors: errsFor(ctx, '/fastTrack/maxSeverity') })}
${fieldHtml({ pointer: '/fastTrack/maxFraudScore', label: 'Maximum fraud score', kind: 'int', value: ft.maxFraudScore, errors: errsFor(ctx, '/fastTrack/maxFraudScore') })}
${fieldHtml({ pointer: '/fastTrack/maxEstimate/amount', label: 'Maximum estimate (amount)', kind: 'number', value: ft.maxEstimate?.amount, errors: errsFor(ctx, '/fastTrack/maxEstimate/amount') })}
</div></fieldset>` : '';
  return `<h2 id="h-rules" tabindex="-1">Rules</h2>${ftHtml}${items}<p>${btn('add', '/rules', 'Add rule')}</p>`;
}

export function timersHtml(ctx) {
  const timers = ctx.cfg.timers ?? [];
  const items = timers.map((t, i) => {
    const p = `/timers/${i}`;
    return `<fieldset class="item" data-item="${p}"><legend>Timer ${i + 1}: ${esc(t.id)}</legend>
${itemControls('/timers', i, timers.length, 'timer')}
<div class="cols">
${fieldHtml({ pointer: `${p}/id`, label: 'Id', value: t.id, errors: errsFor(ctx, `${p}/id`) })}
${fieldHtml({ pointer: `${p}/state`, label: 'State', kind: 'select', options: US_STATES, value: t.state, errors: errsFor(ctx, `${p}/state`) })}
${fieldHtml({ pointer: `${p}/kind`, label: 'Kind', kind: 'select', options: TIMER_KINDS, value: t.kind, errors: errsFor(ctx, `${p}/kind`) })}
${fieldHtml({ pointer: `${p}/duration/value`, label: 'Duration', kind: 'int', value: t.duration?.value, errors: errsFor(ctx, `${p}/duration/value`) })}
${fieldHtml({ pointer: `${p}/duration/unit`, label: 'Unit', kind: 'select', options: TIMER_UNITS, value: t.duration?.unit, errors: errsFor(ctx, `${p}/duration/unit`) })}
${fieldHtml({ pointer: `${p}/startOn`, label: 'Starts on event', value: t.startOn, errors: errsFor(ctx, `${p}/startOn`) })}
${fieldHtml({ pointer: `${p}/lobs`, label: 'Lines of business (comma separated)', kind: 'csv', value: t.lobs, errors: errsFor(ctx, `${p}/lobs`, true) })}
</div></fieldset>`;
  }).join('');
  return `<h2 id="h-timers" tabindex="-1">Regulatory timers</h2>${items}<p>${btn('add', '/timers', 'Add timer')}</p>`;
}

export function webhooksHtml(ctx) {
  const wh = ctx.cfg.notifications?.webhooks ?? {};
  const subs = ctx.webhooks;
  let list;
  if (!subs) list = '<p class="muted">Loading subscriptions.</p>';
  else if (!subs.available) list = '<p class="muted" role="status">The webhook service is not available in this deployment.</p>';
  else if (!subs.items.length) list = '<p class="muted">No webhook subscriptions yet.</p>';
  else {
    list = `<table class="grid-table"><caption class="fx-visually-hidden">Webhook subscriptions</caption><thead><tr><th scope="col">URL</th><th scope="col">Events</th><th scope="col">Active</th><th scope="col">Actions</th></tr></thead><tbody>${subs.items.map((s) => `<tr data-webhook="${esc(s.id)}"><td>${esc(s.url)}</td><td>${esc((s.eventTypes ?? []).join(', '))}</td><td>${s.active === false ? 'No' : 'Yes'}</td><td><button type="button" class="fx-btn secondary small" data-act="wh-toggle" data-id="${esc(s.id)}" data-active="${s.active === false ? 'true' : 'false'}">${s.active === false ? 'Enable' : 'Disable'}</button> <button type="button" class="fx-btn secondary small" data-act="wh-delete" data-id="${esc(s.id)}" aria-label="Delete webhook ${esc(s.url)}">Delete</button></td></tr>`).join('')}</tbody></table>`;
  }
  return `<h2 id="h-webhooks" tabindex="-1">Webhooks</h2>
<fieldset><legend>Delivery settings (saved with the configuration)</legend><div class="cols">
${fieldHtml({ pointer: '/notifications/webhooks/enabled', label: 'Webhooks enabled', kind: 'bool', value: wh.enabled !== false, errors: errsFor(ctx, '/notifications/webhooks/enabled') })}
${fieldHtml({ pointer: '/notifications/webhooks/allowedHosts', label: 'Allowed hosts (comma separated)', kind: 'csv', value: wh.allowedHosts, errors: errsFor(ctx, '/notifications/webhooks/allowedHosts', true) })}
</div></fieldset>
<h3>Subscriptions</h3>${list}
<form id="wh-form" novalidate class="item"><h3>Add subscription</h3>
<div class="field"><label for="wh-url">Endpoint URL</label><input id="wh-url" type="text" autocomplete="off"></div>
<div class="field"><label for="wh-events">Event types (comma separated)</label><input id="wh-events" type="text" value="claim.created, claim.routed"></div>
<p id="wh-msg" class="err" role="alert"></p>
<button type="submit" class="fx-btn" id="wh-add">Create subscription</button></form>`;
}

export function historyHtml(ctx) {
  const h = ctx.history;
  const cur = `<p>Current version <strong>${esc(ctx.version)}</strong>${ctx.cfg.updatedBy ? `, last saved by ${esc(ctx.cfg.updatedBy)}` : ''}${ctx.cfg.updatedAt ? ` at ${esc(ctx.cfg.updatedAt)}` : ''}.</p>`;
  let body;
  if (!h) body = '<p class="muted">Loading history.</p>';
  else if (!h.available) body = '<p class="muted" id="history-fallback" role="status">Version history is not available from the server yet. Only the current version is shown.</p>';
  else body = `<table class="grid-table"><caption class="fx-visually-hidden">Configuration versions</caption><thead><tr><th scope="col">Version</th><th scope="col">Saved by</th><th scope="col">When</th><th scope="col">Changed</th></tr></thead><tbody>${h.rows.map((r) => `<tr data-version="${r.version}"><td>${r.version}</td><td>${esc(r.actor)}</td><td>${esc(r.at)}</td><td>${esc((r.changed ?? []).join(', '))}</td></tr>`).join('')}</tbody></table>`;
  return `<h2 id="h-history" tabindex="-1">Version history</h2>${cur}${body}`;
}

export function kpisHtml(ctx) {
  const k = ctx.kpis;
  let body;
  if (!k) body = '<p class="muted">Loading KPIs.</p>';
  else if (!k.available) body = '<p class="muted" id="kpi-fallback" role="status">KPIs are not available from the server yet.</p>';
  else {
    const rows = flattenKpis(k.body);
    body = rows.length
      ? `<table class="grid-table"><caption class="fx-visually-hidden">Operational KPIs</caption><thead><tr><th scope="col">Metric</th><th scope="col">Value</th></tr></thead><tbody>${rows.map((r) => `<tr><th scope="row">${esc(r.key)}</th><td>${esc(r.value)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No KPI data for this period.</p>';
  }
  return `<h2 id="h-kpis" tabindex="-1">KPIs</h2><p><button type="button" class="fx-btn secondary" data-act="kpi-refresh">Refresh</button></p>${body}`;
}

const PANELS = { branding: brandingHtml, lobs: lobsHtml, locales: localesHtml, questions: questionsHtml, rules: rulesHtml, timers: timersHtml, webhooks: webhooksHtml, history: historyHtml, kpis: kpisHtml };

/** Panel markup for a tab. @param {string} tab @param {object} ctx */
export function panelHtml(tab, ctx) { return (PANELS[tab] ?? brandingHtml)(ctx); }

/** Tab bar with per-section error counts. */
export function tabsHtml(active, report) {
  return TABS.map(([id, label]) => {
    const n = report?.bySection?.[id] ?? 0;
    return `<button type="button" role="tab" id="tab-${id}" data-tab="${id}" aria-selected="${id === active}" aria-controls="panel"${id === active ? '' : ' tabindex="-1"'}>${esc(label)}${n ? ` <span class="badge" aria-label="${n} problems">${n}</span>` : ''}</button>`;
  }).join('');
}

/** Error summary shown after a failed validation. */
export function summaryHtml(report) {
  if (!report) return '';
  if (report.valid) return `<p class="ok" role="status">Configuration is valid.${report.warnings?.length ? ` ${report.warnings.length} warning(s).` : ''}</p>`;
  return `<div class="summary" role="alert"><h2>${report.errors.length} problem${report.errors.length === 1 ? '' : 's'} to fix</h2><ul>${report.errors.map((e) => `<li><a href="#" data-goto="${esc(e.path)}" data-section="${e.section}">${esc(e.path || '(document)')}</a>: ${esc(e.message)}</li>`).join('')}</ul></div>`;
}

export { toPointer };
