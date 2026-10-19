// Pure HTML builders for the admin console. Every dynamic value is escaped.
import {
  configLocales, describeChange, describeCondition, displayValue, errorsFor, errorsUnder, getAt, humanizeActor, i18nGet, inheritedThreshold, lobLabel, orderedListSpec,
  runSequence, setTitle, toJsonText, toPointer, flattenKpis, kpiTiles,
} from './config-model.js';
import { icon } from '../shared/icons.js';
import { formatDateTime, formatEnum } from '../shared/format.js';

/** Console sections: [id, label, icon, one-line description]. */
export const TABS = [
  ['branding', 'Branding', 'building', 'Name, colours, languages and legal text claimants see.'],
  ['questions', 'Intake questions', 'list', 'Lines of business and the questions asked at intake.'],
  ['rules', 'Routing and fast-track rules', 'layers', 'Who handles a claim, and which claims skip manual review.'],
  ['timers', 'Regulatory timers', 'clock', 'Deadlines the platform tracks for each state.'],
  ['webhooks', 'Integrations and webhooks', 'link', 'Where claim events are delivered.'],
  ['ai', 'AI settings', 'sparkles', 'Which models assist intake, and how much they are trusted.'],
  ['security', 'Security and data', 'shield', 'Session length, data retention and the data key reference.'],
  ['kpis', 'KPIs', 'gauge', 'How the platform is performing for this carrier.'],
  ['history', 'Version history', 'calendar', 'Who changed the configuration, and when.'],
];
export const SECTION_LABEL = Object.fromEntries(TABS.map((t) => [t[0], t[1]]));
/** Sections that only show data; the save bar does not apply to them (ADMIN-19). */
export const READ_ONLY_TABS = ['kpis', 'history'];
export const QUESTION_TYPES = ['text', 'longtext', 'number', 'currency', 'boolean', 'date', 'time', 'datetime', 'select', 'multiselect', 'address', 'location', 'phone', 'email', 'vin', 'party', 'vehicle', 'media', 'disclosure'];
export const RULE_STAGES = ['intake', 'triage', 'routing', 'post_routing'];
export const TIMER_KINDS = ['acknowledge', 'contact', 'decide'];
export const TIMER_UNITS = ['hours', 'days', 'business_days'];

// Readable option labels (ADMIN-10). Values stay the stored codes.
const opts = (map) => Object.entries(map).map(([value, label]) => ({ value, label }));
export const PROVIDER_OPTIONS = opts({ cascade: 'Provider cascade (tries each provider in order)', local: 'Local model only', 'vertex-claude': 'Cloud model A (Vertex AI)', 'vertex-gemini': 'Cloud model B (Vertex AI)' });
export const STAGE_OPTIONS = opts({ intake: 'Intake', triage: 'Triage', routing: 'Routing', post_routing: 'Post-routing' });
export const TIMER_KIND_OPTIONS = opts({ acknowledge: 'Acknowledge the claim', contact: 'First contact', decide: 'Coverage decision' });
export const UNIT_OPTIONS = opts({ hours: 'Hours', days: 'Calendar days', business_days: 'Business days' });
export const ASSIGNMENT_OPTIONS = opts({ round_robin: 'Round robin', least_loaded: 'Least loaded adjuster', manual: 'Manual (supervisor assigns)' });
export const PUSH_ON_OPTIONS = opts({ 'claim.reported': 'When the claim is reported', 'claim.routed': 'When the claim is routed', manual: 'Manually' });
const TYPE_OPTIONS = QUESTION_TYPES.map((t) => ({ value: t, label: { vin: 'VIN', longtext: 'Long text', multiselect: 'Multiple choice', select: 'Single choice', datetime: 'Date and time', boolean: 'Yes or no' }[t] ?? formatEnum(t) }));
export const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];

/** Escape text for HTML content and attributes. @param {any} v */
export function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Stable element id for a pointer (and optional suffix). */
export const fieldId = (pointer, suffix = '') => `f${String(pointer).replace(/[^a-zA-Z0-9]+/g, '-')}${suffix ? `-${suffix}` : ''}`;


/**
 * One labelled control.
 * @param {{pointer:string, label:string, kind?:string, value?:any, options?:string[], hint?:string, errors?:Array<{message:string}>, rows?:number, locale?:string, attrs?:string, rawText?:string}} p
 */
export function fieldHtml(p) {
  const kind = p.kind ?? 'text';
  const id = fieldId(p.pointer, p.locale);
  const errs = p.errors ?? [];
  const invalid = errs.length ? ' aria-invalid="true"' : '';
  const desc = [p.hint ? `${id}-hint` : '', errs.length ? `${id}-err` : ''].filter(Boolean).join(' ');
  const base = `id="${id}" data-path="${esc(p.pointer)}" data-kind="${esc(kind)}"${p.locale ? ` data-locale="${esc(p.locale)}"` : ''}${invalid}${desc ? ` aria-describedby="${desc}"` : ''} ${p.attrs ?? ''}`;
  const hint = p.hint ? `<p class="hint" id="${id}-hint">${esc(p.hint)}</p>` : '';
  if (kind === 'bool') {
    return `<div class="field field-bool"><div class="fx-check-row"><input type="checkbox" class="fx-switch" role="switch" ${base}${p.value ? ' checked' : ''}> <label for="${id}">${esc(p.label)}</label></div>${hint}${errHtml(id, errs, p.pointer)}</div>`;
  }
  let control;
  if (kind === 'select') {
    const list = (p.options ?? []).map((o) => (o && typeof o === 'object' ? o : { value: o, label: o }));
    const known = list.some((o) => o.value === p.value);
    const extra = p.value !== undefined && p.value !== '' && !known ? `<option value="${esc(p.value)}" selected>${esc(p.value)}</option>` : '';
    const opts = extra + list.map((o) => `<option value="${esc(o.value)}"${o.value === p.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
    control = `<select class="fx-select" ${base}>${p.value === undefined || p.value === '' ? '<option value=""></option>' : ''}${opts}</select>`;
  } else if (kind === 'json') {
    control = `<textarea class="fx-textarea mono" ${base} rows="${p.rows ?? 6}" spellcheck="false">${esc(p.rawText !== undefined ? p.rawText : toJsonText(p.value))}</textarea>`;
  } else if (kind === 'csv') {
    control = `<input type="text" class="fx-input" ${base} value="${esc(Array.isArray(p.value) ? p.value.join(', ') : '')}"${p.placeholder ? ` placeholder="${esc(p.placeholder)}"` : ''}>`;
  } else {
    const type = kind === 'number' || kind === 'int' ? 'number' : 'text';
    control = `<input type="${type}" class="fx-input" ${base} value="${esc(p.value ?? '')}"${type === 'number' ? ' step="any"' : ''}${p.placeholder ? ` placeholder="${esc(p.placeholder)}"` : ''}>`;
  }
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

const btn = (act, pointer, text, extra = '', cls = 'secondary small', ic = '') => `<button type="button" class="fx-btn ${cls}" data-act="${act}" data-path="${esc(pointer)}"${extra}>${ic ? icon(ic, { size: 16 }) : ''}${esc(text)}</button>`;

/** A settings card. Item cards put their controls in the header actions slot. */
function card(heading, sub, body, { id, actions = '', cls = '', item } = {}) {
  return `<fx-card${id ? ` id="${esc(id)}"` : ''} class="adm-card ${cls}"${item ? ` data-item="${esc(item)}"` : ''} heading="${esc(heading)}"${sub ? ` subheading="${esc(sub)}"` : ''}>${actions ? `<div slot="actions">${actions}</div>` : ''}${body}</fx-card>`;
}

/**
 * Move and remove buttons for a list item. `i` is the array index the action applies to; `pos` the position shown
 * (run order), `canUp`/`canDown` whether a move is possible from there.
 */
function itemControls(listPtr, i, len, noun, { pos = i, canUp = pos > 0, canDown = pos < len - 1 } = {}) {
  const b = (act, text, ic, extra = '') => `<button type="button" class="fx-btn ghost small icon" data-act="${act}" data-path="${esc(listPtr)}" data-index="${i}" aria-label="${text} ${esc(noun)} ${pos + 1}"${extra}>${icon(ic, { size: 16 })}</button>`;
  return `<div class="item-actions">${b('up', 'Move up', 'arrow-up', canUp ? '' : ' disabled')}${b('down', 'Move down', 'arrow-down', canDown ? '' : ' disabled')}${b('remove', 'Remove', 'trash')}</div>`;
}

/** Array indices of a list in the order the platform uses it, for display. */
const runOrder = (list, pointer) => runSequence(list, orderedListSpec(pointer));

const head = (id, title, sub) => `<header class="adm-head"><h2 id="h-${id}" tabindex="-1">${esc(title)}</h2>${sub ? `<p class="muted">${esc(sub)}</p>` : ''}</header>`;
const addRow = (html) => `<div class="adm-add">${html}</div>`;
const grid = (html) => `<div class="cols">${html}</div>`;

// ---- panels
export function brandingHtml(ctx) {
  const f = (key, label, kind = 'text', hint) => fieldHtml({ pointer: `/branding/${key}`, label, kind, value: getAt(ctx.cfg, `/branding/${key}`), errors: errsFor(ctx, `/branding/${key}`), hint });
  const sw = (v, name) => `<span class="swatch-item"><span class="swatch" style="background:${esc(/^#[0-9a-fA-F]{6}$/.test(v ?? '') ? v : '#ffffff')}"></span>${name} <code>${esc(v ?? 'not set')}</code></span>`;
  return `${head('branding', 'Branding', TABS[0][3])}
${card('Identity', 'How the carrier is named across the claimant, CSR and adjuster apps.', grid(`
${fieldHtml({ pointer: '/displayName', label: 'Display name', value: ctx.cfg.displayName, errors: errsFor(ctx, '/displayName'), hint: 'Shown in the header of every app.' })}
${fieldHtml({ pointer: '/claimNumberPrefix', label: 'Claim number prefix', value: ctx.cfg.claimNumberPrefix, errors: errsFor(ctx, '/claimNumberPrefix'), hint: '2 to 5 capital letters, for example AUR.' })}
${fieldHtml({ pointer: '/timeZone', label: 'Time zone', value: ctx.cfg.timeZone, errors: errsFor(ctx, '/timeZone'), hint: 'IANA name such as America/Chicago. Used for deadlines.' })}`))}
${card('Colours and contact', 'Brand colours must be six-digit hex values; text colour is chosen automatically for contrast.', `${grid(`
${f('primaryColor', 'Primary color', 'text', 'Hex such as #0b5cad.')}
${f('accentColor', 'Accent color', 'text', 'Hex such as #7a3e00.')}
${f('fontFamily', 'Font family', 'text', 'A CSS font stack. Leave empty for the product font.')}
${f('logoUrl', 'Logo path', 'text', 'A path on this site, for example /assets/logo.svg.')}
${f('supportPhone', 'Support phone')}
${f('supportEmail', 'Support email')}`)}
<div class="swatch-row" aria-label="Colour preview">${sw(ctx.cfg.branding?.primaryColor, 'Primary')}${sw(ctx.cfg.branding?.accentColor, 'Accent')}</div>`)}
${card('Languages', 'Text fields elsewhere in this console gain one input per language listed here.', fieldHtml({ pointer: '/locales', label: 'Locales (comma separated)', kind: 'csv', value: ctx.cfg.locales ?? ['en'], errors: errsFor(ctx, '/locales', true), hint: 'BCP 47 tags such as en, es, fr-CA.' }))}
${card('Legal footer', 'Appears at the bottom of claimant pages and notices.', i18nField(ctx, '/branding/legalFooter', 'Legal footer'))}`;
}

function lobsCard(ctx) {
  const lobs = ctx.cfg.lobs ?? [];
  const items = lobs.map((l, i) => {
    const p = `/lobs/${i}`;
    const title = i18nGet(l.label, 'en') || formatEnum(l.id) || `Line ${i + 1}`;
    return `<div class="adm-item" data-item="${p}"><div class="adm-item-head"><strong>${esc(title)}</strong>${itemControls('/lobs', i, lobs.length, 'line of business')}</div>
${grid(`${fieldHtml({ pointer: `${p}/id`, label: 'Id', value: l.id, errors: errsFor(ctx, `${p}/id`), hint: 'Lowercase letters, digits and underscores.' })}
${fieldHtml({ pointer: `${p}/acordLobCd`, label: 'ACORD LOB code', value: l.acordLobCd, errors: errsFor(ctx, `${p}/acordLobCd`) })}
${fieldHtml({ pointer: `${p}/states`, label: 'States (comma separated)', kind: 'csv', value: l.states, errors: errsFor(ctx, `${p}/states`, true), hint: `Two-letter codes, for example ${US_STATES.slice(0, 3).join(', ')}.` })}
${fieldHtml({ pointer: `${p}/enabled`, label: 'Enabled', kind: 'bool', value: l.enabled, errors: errsFor(ctx, `${p}/enabled`), hint: 'Disabled lines are hidden from claimants.' })}`)}
${i18nField(ctx, `${p}/label`, 'Label')}</div>`;
  }).join('');
  return card('Lines of business', 'Products a claimant can report a loss against.', `${items || '<p class="muted">No lines of business yet.</p>'}${addRow(btn('add', '/lobs', 'Add line of business', '', 'secondary small', 'plus'))}`, { id: 'card-lobs' });
}

export function questionsHtml(ctx) {
  const sets = ctx.cfg.questionSets ?? [];
  const si = Math.min(Math.max(ctx.qSet ?? 0, 0), Math.max(sets.length - 1, 0));
  const set = sets[si];
  const picker = `<div class="adm-picker"><div class="field"><label for="qset-pick">Question set</label><select id="qset-pick" class="fx-select" data-ui="qset">${sets.map((s, i) => `<option value="${i}"${i === si ? ' selected' : ''}>${esc(setTitle(s.id))} (${esc(lobLabel(ctx.cfg, s.lob))})</option>`).join('')}</select></div>${btn('add', '/questionSets', 'Add question set', '', 'secondary small', 'plus')}</div>`;
  if (!set) return `${head('questions', 'Intake questions', TABS[1][3])}${lobsCard(ctx)}${card('Question sets', 'Groups of questions asked for one line of business.', `${picker}<p class="muted">No question sets yet.</p>`)}`;
  const sp = `/questionSets/${si}`;
  const qList = set.questions ?? [];
  // Shown in the order claimants are asked (the order field), which is also what the arrows change.
  const qs = runOrder(qList, `${sp}/questions`).map((i, pos) => {
    const q = qList[i];
    const p = `${sp}/questions/${i}`;
    const showIfErr = errsFor(ctx, `${p}/showIf`, true);
    return card(`Question ${pos + 1}: ${q.id ?? ''}`, q.type ? TYPE_OPTIONS.find((o) => o.value === q.type)?.label ?? formatEnum(q.type) : 'Choose a type', `${grid(`
${fieldHtml({ pointer: `${p}/id`, label: 'Id', value: q.id, errors: errsFor(ctx, `${p}/id`), hint: 'Lowercase letters, digits and underscores.' })}
${fieldHtml({ pointer: `${p}/type`, label: 'Type', kind: 'select', options: TYPE_OPTIONS, value: q.type, errors: errsFor(ctx, `${p}/type`) })}
${fieldHtml({ pointer: `${p}/order`, label: 'Order', kind: 'int', value: q.order, errors: errsFor(ctx, `${p}/order`), hint: 'Lower numbers are asked first.' })}
${fieldHtml({ pointer: `${p}/required`, label: 'Required', kind: 'bool', value: q.required, errors: errsFor(ctx, `${p}/required`) })}`)}
${i18nField(ctx, `${p}/text`, 'Question text')}
${fieldHtml({ pointer: `${p}/showIf`, label: 'Show if (condition JSON, empty = always ask)', kind: 'json', rawText: ctx.rawText?.[`${p}/showIf`], value: q.showIf, errors: showIfErr, rows: 5, hint: `Reads as: ${describeCondition(q.showIf)}` })}
${q.type === 'select' || q.type === 'multiselect' ? fieldHtml({ pointer: `${p}/options`, label: 'Options (JSON list of value and label)', kind: 'json', rawText: ctx.rawText?.[`${p}/options`], value: q.options, errors: errsFor(ctx, `${p}/options`, true), rows: 4 }) : ''}`,
    { item: p, actions: itemControls(`${sp}/questions`, i, qList.length, 'question', { pos }) });
  }).join('');
  return `${head('questions', 'Intake questions', TABS[1][3])}
${lobsCard(ctx)}
${card('Question set', 'Groups of questions asked for one line of business.', `${picker}${grid(`
${fieldHtml({ pointer: `${sp}/id`, label: 'Set id', value: set.id, errors: errsFor(ctx, `${sp}/id`) })}
${fieldHtml({ pointer: `${sp}/lob`, label: 'Line of business', kind: 'select', options: (ctx.cfg.lobs ?? []).map((l) => ({ value: l.id, label: lobLabel(ctx.cfg, l.id) })), value: set.lob, errors: errsFor(ctx, `${sp}/lob`) })}
${fieldHtml({ pointer: `${sp}/version`, label: 'Set version', kind: 'int', value: set.version, errors: errsFor(ctx, `${sp}/version`) })}`)}
${addRow(btn('remove', '/questionSets', 'Remove this set', ` data-index="${si}"`, 'danger secondary small', 'trash'))}`)}
${qs}${addRow(btn('add', `${sp}/questions`, 'Add question', '', 'secondary small', 'plus'))}`;
}

export function rulesHtml(ctx) {
  const rules = ctx.cfg.rules ?? [];
  const ft = ctx.cfg.fastTrack;
  const seq = runOrder(rules, '/rules');
  const stageOf = (r) => r?.stage ?? '';
  // Shown in the order the engine runs them: by stage, then priority. The arrows change priority within a stage.
  const items = seq.map((i, pos) => {
    const r = rules[i];
    const p = `/rules/${i}`;
    const canUp = pos > 0 && stageOf(rules[seq[pos - 1]]) === stageOf(r);
    const canDown = pos < seq.length - 1 && stageOf(rules[seq[pos + 1]]) === stageOf(r);
    const stageLabel = STAGE_OPTIONS.find((o) => o.value === r.stage)?.label ?? (r.stage ? formatEnum(r.stage) : '');
    return card(`Rule ${pos + 1}: ${r.id ?? ''}`, [r.name, stageLabel].filter(Boolean).join(' · '), `${grid(`
${fieldHtml({ pointer: `${p}/id`, label: 'Id', value: r.id, errors: errsFor(ctx, `${p}/id`), hint: 'Capitals, digits and dashes, for example RT-INJURY-01.' })}
${fieldHtml({ pointer: `${p}/name`, label: 'Name', value: r.name, errors: errsFor(ctx, `${p}/name`) })}
${fieldHtml({ pointer: `${p}/stage`, label: 'Stage', kind: 'select', options: STAGE_OPTIONS, value: r.stage, errors: errsFor(ctx, `${p}/stage`) })}
${fieldHtml({ pointer: `${p}/priority`, label: 'Priority (lower runs first)', kind: 'int', value: r.priority, errors: errsFor(ctx, `${p}/priority`), placeholder: '100' })}
${fieldHtml({ pointer: `${p}/enabled`, label: 'Enabled', kind: 'bool', value: r.enabled !== false, errors: errsFor(ctx, `${p}/enabled`) })}
${fieldHtml({ pointer: `${p}/stopOnMatch`, label: 'Stop on match', kind: 'bool', value: r.stopOnMatch === true, errors: errsFor(ctx, `${p}/stopOnMatch`), hint: 'Later rules at this stage are skipped when this one matches.' })}`)}
${fieldHtml({ pointer: `${p}/when`, label: 'When (condition JSON)', kind: 'json', rawText: ctx.rawText?.[`${p}/when`], value: r.when, errors: errsFor(ctx, `${p}/when`, true), rows: 8, hint: `Reads as: ${describeCondition(r.when)}` })}
${fieldHtml({ pointer: `${p}/then`, label: 'Then (list of actions, JSON)', kind: 'json', rawText: ctx.rawText?.[`${p}/then`], value: r.then, errors: errsFor(ctx, `${p}/then`, true), rows: 6, hint: `Queues you can route to: ${(ctx.cfg.queues ?? []).map((q) => q.id).join(', ') || 'none yet'}.` })}`,
    { item: p, actions: itemControls('/rules', i, rules.length, 'rule', { pos, canUp, canDown }) });
  }).join('');
  const ftHtml = ft ? card('Fast-track limits', 'Claims at or under every limit skip manual review (straight-through processing).', grid(`
${fieldHtml({ pointer: '/fastTrack/enabled', label: 'Fast track enabled', kind: 'bool', value: ft.enabled, errors: errsFor(ctx, '/fastTrack/enabled') })}
${fieldHtml({ pointer: '/fastTrack/maxSeverity', label: 'Maximum severity', kind: 'int', value: ft.maxSeverity, errors: errsFor(ctx, '/fastTrack/maxSeverity'), hint: 'Score from 0 to 100.' })}
${fieldHtml({ pointer: '/fastTrack/maxFraudScore', label: 'Maximum fraud score', kind: 'int', value: ft.maxFraudScore, errors: errsFor(ctx, '/fastTrack/maxFraudScore'), hint: 'Score from 0 to 100.' })}
${fieldHtml({ pointer: '/fastTrack/maxEstimate/amount', label: 'Maximum estimate (amount)', kind: 'number', value: ft.maxEstimate?.amount, errors: errsFor(ctx, '/fastTrack/maxEstimate/amount'), hint: 'In the carrier currency.' })}`), { id: 'card-fasttrack' }) : '';
  const bands = ctx.cfg.severityBands ?? {};
  const bandsHtml = card('Severity bands', 'Severity scores (0 to 100) at or above each value get that band on the adjuster desk.', grid(`
${fieldHtml({ pointer: '/severityBands/moderate', label: 'Moderate from', kind: 'int', value: bands.moderate, errors: errsFor(ctx, '/severityBands/moderate'), placeholder: '25', hint: 'Blank uses 25.' })}
${fieldHtml({ pointer: '/severityBands/major', label: 'Major from', kind: 'int', value: bands.major, errors: errsFor(ctx, '/severityBands/major'), placeholder: '50', hint: 'Blank uses 50.' })}
${fieldHtml({ pointer: '/severityBands/severe', label: 'Severe from', kind: 'int', value: bands.severe, errors: errsFor(ctx, '/severityBands/severe'), placeholder: '75', hint: 'Blank uses 75.' })}`), { id: 'card-severity' });
  return `${head('rules', 'Routing and fast-track rules', TABS[2][3])}${ftHtml}${queuesCard(ctx)}${bandsHtml}${items}${addRow(btn('add', '/rules', 'Add rule', '', 'secondary small', 'plus'))}`;
}

/** Work queues that routing rules point to, with their adjusters and SLA (ADMIN-4). */
function queuesCard(ctx) {
  const queues = ctx.cfg.queues ?? [];
  const items = queues.map((q, i) => {
    const p = `/queues/${i}`;
    const title = i18nGet(q.label, 'en') || q.id || `Queue ${i + 1}`;
    return `<div class="adm-item" data-item="${p}"><div class="adm-item-head"><strong>${esc(title)}</strong>${itemControls('/queues', i, queues.length, 'queue')}</div>
${grid(`${fieldHtml({ pointer: `${p}/id`, label: 'Id', value: q.id, errors: errsFor(ctx, `${p}/id`), hint: 'Lowercase letters, digits and underscores. Rules route to this id.' })}
${fieldHtml({ pointer: `${p}/assignment`, label: 'Assignment', kind: 'select', options: ASSIGNMENT_OPTIONS, value: q.assignment, errors: errsFor(ctx, `${p}/assignment`) })}
${fieldHtml({ pointer: `${p}/adjusters`, label: 'Adjusters (comma separated ids)', kind: 'csv', value: q.adjusters, errors: errsFor(ctx, `${p}/adjusters`, true), hint: 'Adjuster user ids, for example adj-101.' })}
${fieldHtml({ pointer: `${p}/slaHours`, label: 'SLA (hours)', kind: 'int', value: q.slaHours, errors: errsFor(ctx, `${p}/slaHours`), hint: 'Time to first touch.' })}
${fieldHtml({ pointer: `${p}/lobs`, label: 'Lines of business (comma separated)', kind: 'csv', value: q.lobs, errors: errsFor(ctx, `${p}/lobs`, true), hint: 'Empty takes every line.' })}
${fieldHtml({ pointer: `${p}/skills`, label: 'Skills (comma separated)', kind: 'csv', value: q.skills, errors: errsFor(ctx, `${p}/skills`, true) })}
${fieldHtml({ pointer: `${p}/maxSeverity`, label: 'Maximum severity', kind: 'int', value: q.maxSeverity, errors: errsFor(ctx, `${p}/maxSeverity`), hint: 'Optional. Score from 0 to 100.' })}`)}
${i18nField(ctx, `${p}/label`, 'Label')}</div>`;
  }).join('');
  const def = fieldHtml({ pointer: '/defaultQueue', label: 'Default queue', kind: 'select', options: queues.map((q) => ({ value: q.id, label: i18nGet(q.label, 'en') || q.id })), value: ctx.cfg.defaultQueue, errors: errsFor(ctx, '/defaultQueue'), hint: 'Used when no routing rule matches. Blank lets the platform choose.' });
  return card('Queues and adjusters', 'Where routed claims wait, who works them and how fast.', `${def}${items || '<p class="muted">No queues yet.</p>'}${addRow(btn('add', '/queues', 'Add queue', '', 'secondary small', 'plus'))}`, { id: 'card-queues' });
}

export function timersHtml(ctx) {
  const timers = ctx.cfg.timers ?? [];
  const items = timers.map((t, i) => {
    const p = `/timers/${i}`;
    const kindLabel = TIMER_KIND_OPTIONS.find((o) => o.value === t.kind)?.label ?? (t.kind ? formatEnum(t.kind) : '');
    return card(`Timer ${i + 1}: ${t.id ?? ''}`, [t.state, kindLabel].filter(Boolean).join(' · '), `${grid(`
${fieldHtml({ pointer: `${p}/id`, label: 'Id', value: t.id, errors: errsFor(ctx, `${p}/id`) })}
${fieldHtml({ pointer: `${p}/state`, label: 'State', kind: 'select', options: US_STATES, value: t.state, errors: errsFor(ctx, `${p}/state`) })}
${fieldHtml({ pointer: `${p}/kind`, label: 'Kind', kind: 'select', options: TIMER_KIND_OPTIONS, value: t.kind, errors: errsFor(ctx, `${p}/kind`) })}
${fieldHtml({ pointer: `${p}/duration/value`, label: 'Duration', kind: 'int', value: t.duration?.value, errors: errsFor(ctx, `${p}/duration/value`) })}
${fieldHtml({ pointer: `${p}/duration/unit`, label: 'Unit', kind: 'select', options: UNIT_OPTIONS, value: t.duration?.unit, errors: errsFor(ctx, `${p}/duration/unit`) })}
${fieldHtml({ pointer: `${p}/startOn`, label: 'Starts on event', value: t.startOn, errors: errsFor(ctx, `${p}/startOn`), hint: 'For example claim.reported.' })}
${fieldHtml({ pointer: `${p}/lobs`, label: 'Lines of business (comma separated)', kind: 'csv', value: t.lobs, errors: errsFor(ctx, `${p}/lobs`, true), hint: 'Empty applies to every line.' })}
${fieldHtml({ pointer: `${p}/warnBefore/value`, label: 'Warn before (amount)', kind: 'int', value: t.warnBefore?.value, errors: errsFor(ctx, `${p}/warnBefore/value`), hint: 'Optional early warning to the adjuster.' })}
${fieldHtml({ pointer: `${p}/warnBefore/unit`, label: 'Warn before (unit)', kind: 'select', options: UNIT_OPTIONS, value: t.warnBefore?.unit, errors: errsFor(ctx, `${p}/warnBefore/unit`) })}`)}
<fieldset class="adm-fieldset"><legend>Stops when</legend>${grid(`
${fieldHtml({ pointer: `${p}/stopOn/event`, label: 'Event', value: t.stopOn?.event, errors: errsFor(ctx, `${p}/stopOn/event`), hint: 'For example claim.status.changed.' })}
${fieldHtml({ pointer: `${p}/stopOn/toStatus`, label: 'New claim status (comma separated)', kind: 'csv', value: t.stopOn?.toStatus, errors: errsFor(ctx, `${p}/stopOn/toStatus`, true) })}
${fieldHtml({ pointer: `${p}/stopOn/taskType`, label: 'Completed task type', value: t.stopOn?.taskType, errors: errsFor(ctx, `${p}/stopOn/taskType`), hint: 'For example acknowledge_claimant.' })}`)}</fieldset>
${fieldHtml({ pointer: `${p}/citation`, label: 'Citation', value: t.citation, errors: errsFor(ctx, `${p}/citation`), hint: 'Source of the deadline. Demo values must say "Illustrative, not legal advice".' })}
${fieldHtml({ pointer: `${p}/onBreach`, label: 'On breach (list of actions, JSON)', kind: 'json', rawText: ctx.rawText?.[`${p}/onBreach`], value: t.onBreach, errors: errsFor(ctx, `${p}/onBreach`, true), rows: 6, hint: 'Same actions as routing rules, for example add_flag or add_task.' })}`,
    { item: p, actions: itemControls('/timers', i, timers.length, 'timer') });
  }).join('');
  const holidays = card('Holidays', 'Days skipped when counting business-day deadlines.', fieldHtml({ pointer: '/holidays', label: 'Holidays (comma separated dates)', kind: 'csv', value: ctx.cfg.holidays, errors: errsFor(ctx, '/holidays', true), hint: 'Dates as YYYY-MM-DD, for example 2026-12-25.' }), { id: 'card-holidays' });
  return `${head('timers', 'Regulatory timers', TABS[3][3])}${holidays}${items || '<fx-empty-state icon="clock" heading="No timers configured" description="Add a timer to track a state deadline."></fx-empty-state>'}${addRow(btn('add', '/timers', 'Add timer', '', 'secondary small', 'plus'))}`;
}

export function webhooksHtml(ctx) {
  const wh = ctx.cfg.notifications?.webhooks ?? {};
  const cl = ctx.cfg.notifications?.claimant ?? {};
  const inn = ctx.cfg.notifications?.internal ?? {};
  const pp = ctx.cfg.integrations?.policyPort ?? {};
  const cp = ctx.cfg.integrations?.claimsPort ?? {};
  const subs = ctx.webhooks;
  let list;
  if (!subs) list = '<p class="muted card-pad">Loading subscriptions.</p>';
  else if (!subs.available) list = '<p class="muted card-pad" role="status">The webhook service is not available in this deployment.</p>';
  else if (!subs.items.length) list = '<fx-empty-state icon="link" heading="No webhook subscriptions yet" description="Add an endpoint below to receive claim events."></fx-empty-state>';
  else {
    list = `<table class="fx-table grid-table wh-table"><caption class="fx-visually-hidden">Webhook subscriptions</caption><thead><tr><th scope="col">URL</th><th scope="col">Events</th><th scope="col">Status</th><th scope="col"><span class="fx-visually-hidden">Actions</span></th></tr></thead><tbody>${subs.items.map((s) => `<tr data-webhook="${esc(s.id)}"><td class="fx-mono" data-label="URL">${esc(s.url)}</td><td data-label="Events">${esc((s.eventTypes ?? []).join(', '))}</td><td data-label="Status"><fx-badge tone="${s.active === false ? 'neutral' : 'success'}" label="${s.active === false ? 'Paused' : 'Active'}"></fx-badge></td><td class="actions"><button type="button" class="fx-btn secondary small" data-act="wh-toggle" data-id="${esc(s.id)}" data-active="${s.active === false ? 'true' : 'false'}">${s.active === false ? 'Enable' : 'Disable'}</button> <button type="button" class="fx-btn danger secondary small" data-act="wh-delete" data-id="${esc(s.id)}" aria-label="Delete webhook ${esc(s.url)}">Delete</button></td></tr>`).join('')}</tbody></table>`;
  }
  // The one-time signing secret stays on screen until the admin confirms they stored it (ADMIN-14).
  const secret = ctx.newSecret ? `<div class="fx-alert wh-secret" data-tone="warning" role="status" id="wh-secret">${icon('key', { size: 20 })}<div><strong>Copy the signing secret now</strong>
<p>It is shown only once, for ${esc(ctx.newSecret.url)}. Store it where your receiver verifies signatures.</p>
<div class="wh-secret-row"><code id="wh-secret-value" class="fx-mono">${esc(ctx.newSecret.secret)}</code><button type="button" class="fx-btn secondary small" data-act="wh-copy" id="wh-copy">${ctx.newSecret.copied ? 'Copied' : 'Copy secret'}</button></div>
<p><button type="button" class="fx-btn small" data-act="wh-secret-done" id="wh-secret-done">I have stored the secret</button></p></div></div>` : '';
  return `${head('webhooks', 'Integrations and webhooks', TABS[4][3])}
${secret}
${card('Delivery settings', 'Saved with the rest of the configuration.', grid(`
${fieldHtml({ pointer: '/notifications/webhooks/enabled', label: 'Webhooks enabled', kind: 'bool', value: wh.enabled !== false, errors: errsFor(ctx, '/notifications/webhooks/enabled'), hint: 'Turn off to pause every delivery.' })}
${fieldHtml({ pointer: '/notifications/webhooks/allowedHosts', label: 'Allowed hosts (comma separated)', kind: 'csv', value: wh.allowedHosts, errors: errsFor(ctx, '/notifications/webhooks/allowedHosts', true), hint: 'Events are only sent to these hosts.' })}`))}
<fx-card class="adm-card" heading="Subscriptions" subheading="Changes here apply immediately; they are not part of the unsaved configuration." padding="none">${list}</fx-card>
<fx-card class="adm-card" heading="Add subscription" subheading="The signing secret is shown once after creation."><form id="wh-form" novalidate>
<div class="cols"><div class="field"><label for="wh-url">Endpoint URL</label><input id="wh-url" class="fx-input" type="text" autocomplete="off" aria-describedby="wh-url-hint"><p class="hint" id="wh-url-hint">A full https address.</p></div>
<div class="field"><label for="wh-events">Event types (comma separated)</label><input id="wh-events" class="fx-input" type="text" value="claim.created, claim.routed"></div></div>
<p id="wh-msg" class="err" role="alert"></p>
<button type="submit" class="fx-btn" id="wh-add">Create subscription</button></form></fx-card>
${card('Claimant notifications', 'Messages the claimant receives about their claim.', grid(`
${fieldHtml({ pointer: '/notifications/claimant/channels', label: 'Channels (comma separated)', kind: 'csv', value: cl.channels, errors: errsFor(ctx, '/notifications/claimant/channels', true), hint: 'email, sms or both.' })}
${fieldHtml({ pointer: '/notifications/claimant/onEvents', label: 'Send on events (comma separated)', kind: 'csv', value: cl.onEvents, errors: errsFor(ctx, '/notifications/claimant/onEvents', true), hint: 'For example claim.reported, claim.status.changed.' })}`), { id: 'card-notify-claimant' })}
${card('Internal notifications', 'Emails to the claims team.', grid(`
${fieldHtml({ pointer: '/notifications/internal/onEvents', label: 'Send on events (comma separated)', kind: 'csv', value: inn.onEvents, errors: errsFor(ctx, '/notifications/internal/onEvents', true), hint: 'For example claim.timer.breached.' })}
${fieldHtml({ pointer: '/notifications/internal/emails', label: 'Email addresses (comma separated)', kind: 'csv', value: inn.emails, errors: errsFor(ctx, '/notifications/internal/emails', true) })}`), { id: 'card-notify-internal' })}
${card('Integration ports', 'The policy system the platform looks policies up in, and the claims system it hands claims to.', `${grid(`
${fieldHtml({ pointer: '/integrations/policyPort/adapter', label: 'Policy system adapter', value: pp.adapter, errors: errsFor(ctx, '/integrations/policyPort/adapter'), placeholder: 'mock-pas', hint: 'Blank uses mock-pas.' })}
${fieldHtml({ pointer: '/integrations/claimsPort/adapter', label: 'Claims system adapter', value: cp.adapter, errors: errsFor(ctx, '/integrations/claimsPort/adapter'), placeholder: 'core-claims-suite', hint: 'Blank uses core-claims-suite.' })}
${fieldHtml({ pointer: '/integrations/claimsPort/pushOn', label: 'Hand claims over', kind: 'select', options: PUSH_ON_OPTIONS, value: cp.pushOn, errors: errsFor(ctx, '/integrations/claimsPort/pushOn'), hint: 'Blank hands over when the claim is routed.' })}`)}
${fieldHtml({ pointer: '/integrations/policyPort/settings', label: 'Policy system settings (JSON)', kind: 'json', rawText: ctx.rawText?.['/integrations/policyPort/settings'], value: pp.settings, errors: errsFor(ctx, '/integrations/policyPort/settings', true), rows: 4 })}
${fieldHtml({ pointer: '/integrations/claimsPort/settings', label: 'Claims system settings (JSON)', kind: 'json', rawText: ctx.rawText?.['/integrations/claimsPort/settings'], value: cp.settings, errors: errsFor(ctx, '/integrations/claimsPort/settings', true), rows: 4 })}`, { id: 'card-ports' })}`;
}

export function aiHtml(ctx) {
  const ai = ctx.cfg.ai ?? {};
  const tasks = Object.keys(ai.tasks ?? {});
  const f = (key, label, kind, extra = {}) => fieldHtml({ pointer: `/ai/${key}`, label, kind, value: ai[key], errors: errsFor(ctx, `/ai/${key}`, kind === 'json'), ...extra });
  const taskCards = tasks.map((t) => {
    const p = `/ai/tasks/${t}`;
    const own = ai.tasks[t].threshold;
    const inh = inheritedThreshold(ai, t);
    // A blank threshold is not "no gate": the cascade minimum applies. Say which value (ADMIN-18).
    const hint = Number.isFinite(own) ? 'Between 0 and 1. Below this, a person confirms.' : `Blank: uses ${inh.source} (${inh.value}). Below that, a person confirms.`;
    return `<div class="adm-item" data-item="${esc(p)}"><div class="adm-item-head"><strong>${esc(formatEnum(t))}</strong></div>${grid(`
${fieldHtml({ pointer: `${p}/enabled`, label: 'Enabled', kind: 'bool', value: ai.tasks[t].enabled !== false, errors: errsFor(ctx, `${p}/enabled`) })}
${fieldHtml({ pointer: `${p}/threshold`, label: 'Confidence threshold', kind: 'number', value: own, errors: errsFor(ctx, `${p}/threshold`), hint, placeholder: `${inh.value} (inherited)` })}`)}</div>`;
  }).join('');
  return `${head('ai', 'AI settings', TABS[5][3])}
${card('Provider and safety', 'AI output is always shown with its model and confidence, and never decides coverage on its own.', grid(`
${f('provider', 'Provider', 'select', { options: PROVIDER_OPTIONS, hint: 'Cascade tries each provider below in order.' })}
${f('region', 'Region', 'text', { hint: 'Where model calls are processed.' })}
${f('maxTokensPerClaim', 'Token budget per claim', 'int', { hint: 'Calls stop once a claim reaches this size.' })}
${f('redactPiiBeforeModel', 'Redact personal data before model calls', 'bool', { value: ai.redactPiiBeforeModel !== false })}
${f('humanConfirmRequired', 'Require a person to confirm AI suggestions', 'bool', { value: ai.humanConfirmRequired !== false })}`))}
${card('Task thresholds', 'Turn individual assistants on or off and set how confident they must be.', taskCards || '<p class="muted">No per-task settings.</p>')}
${card('Provider cascade', 'Ordered list of providers, each with a minimum confidence. Advanced.', fieldHtml({ pointer: '/ai/cascade', label: 'Cascade (JSON list)', kind: 'json', rawText: ctx.rawText?.['/ai/cascade'], value: ai.cascade, errors: errsFor(ctx, '/ai/cascade', true), rows: 10, hint: 'Each entry: provider (local, vertex-claude or vertex-gemini), optional model, minConfidence and tasks.' }))}`;
}

export function securityHtml(ctx) {
  const sec = ctx.cfg.security ?? {};
  return `${head('security', 'Security and data', TABS[6][3])}
${card('Sessions and retention', 'How long people stay signed in and how long claim data is kept.', grid(`
${fieldHtml({ pointer: '/security/sessionTtlMinutes', label: 'Session length (minutes)', kind: 'int', value: sec.sessionTtlMinutes, errors: errsFor(ctx, '/security/sessionTtlMinutes'), placeholder: '60', hint: 'Blank uses 60 minutes.' })}
${fieldHtml({ pointer: '/security/dataRetentionDays', label: 'Data retention (days)', kind: 'int', value: sec.dataRetentionDays, errors: errsFor(ctx, '/security/dataRetentionDays'), hint: 'Closed claims older than this are purged.' })}`), { id: 'card-security' })}
${card('Personal data key', 'A reference to the per-tenant encryption key. Never paste the key itself.', fieldHtml({ pointer: '/security/piiKeyRef', label: 'Data key reference', value: sec.piiKeyRef, errors: errsFor(ctx, '/security/piiKeyRef'), hint: 'For example kms://demo/tenant-name.' }))}`;
}

/** Version history rows plus the "current version" line, with people's names and readable section names (ADMIN-2). */
export function historyHtml(ctx) {
  const h = ctx.history;
  const when = (v) => { try { return formatDateTime(v); } catch { return v; } };
  const currentRow = h?.rows?.find((r) => r.version === ctx.version);
  const who = currentRow?.actorName ?? (ctx.cfg.updatedBy ? humanizeActor(ctx.cfg.updatedBy) : '');
  const at = currentRow?.at || ctx.cfg.updatedAt;
  const cur = `<p class="adm-current">Current version <strong>${esc(ctx.version)}</strong>${who ? `, last saved by ${esc(who)}` : ''}${at ? ` on ${esc(when(at))}` : ''}.</p>`;
  let body;
  if (!h) body = '<p class="muted card-pad">Loading history.</p>';
  else if (!h.available) body = '<p class="muted card-pad" id="history-fallback" role="status">Version history could not be loaded. Only the current version is shown.</p>';
  else body = `<table class="fx-table grid-table"><caption class="fx-visually-hidden">Configuration versions</caption><thead><tr><th scope="col" class="fx-num">Version</th><th scope="col">Saved by</th><th scope="col">When</th><th scope="col">Changed</th></tr></thead><tbody>${h.rows.map((r) => `<tr data-version="${r.version}"><td class="fx-num">${r.version}</td><td>${esc(r.actorName ?? r.actor)}</td><td>${esc(r.at ? when(r.at) : '')}</td><td>${esc((r.changed ?? []).join(', '))}</td></tr>`).join('')}</tbody></table>`;
  return `${head('history', 'Version history', TABS[8][3])}${cur}<fx-card class="adm-card" heading="Saved versions" padding="none">${body}</fx-card>`;
}

export function kpisHtml(ctx) {
  const k = ctx.kpis;
  let body;
  if (!k) body = '<div class="fx-stat-grid" aria-busy="true">' + '<fx-skeleton variant="card"></fx-skeleton>'.repeat(4) + '</div><p class="muted" role="status">Loading KPIs.</p>';
  else if (!k.available) body = '<fx-empty-state id="kpi-fallback" icon="gauge" heading="KPIs are not available yet" description="The reporting service did not respond for this deployment."></fx-empty-state>';
  else {
    const tiles = kpiTiles(k.body);
    if (tiles.length) {
      // The hint is the plain count ("3 of 14 claims"); internal value-driver codes are not shown (ADMIN-11).
      body = `<div class="fx-stat-grid" id="kpi-tiles">${tiles.map((t) => `<fx-stat data-kpi="${esc(t.id)}" label="${esc(t.label)}" value="${esc(t.value)}"${t.detail ? ` hint="${esc(`${t.detail} claims`)}"` : ''}${t.hint ? ` title="${esc(t.hint)}"` : ''}></fx-stat>`).join('')}</div>`;
    } else {
      const rows = flattenKpis(k.body);
      body = rows.length
        ? `<fx-card class="adm-card" heading="Operational KPIs" padding="none"><table class="fx-table grid-table"><caption class="fx-visually-hidden">Operational KPIs</caption><thead><tr><th scope="col">Metric</th><th scope="col" class="fx-num">Value</th></tr></thead><tbody>${rows.map((r) => `<tr><th scope="row">${esc(r.key)}</th><td class="fx-num">${esc(r.value)}</td></tr>`).join('')}</tbody></table></fx-card>`
        : '<fx-empty-state icon="gauge" heading="No KPI data for this period" description="Metrics appear once claims have been reported."></fx-empty-state>';
    }
  }
  const period = k?.available && k.body?.period ? `<p class="muted">Period: ${esc(formatDateTime(k.body.period.from))} to ${esc(formatDateTime(k.body.period.to))}</p>` : '';
  return `${head('kpis', 'KPIs', TABS[7][3])}<div class="adm-toolbar">${period}<button type="button" class="fx-btn secondary small" data-act="kpi-refresh">${icon('refresh', { size: 16 })}Refresh</button></div>${body}`;
}

const PANELS = { branding: brandingHtml, questions: questionsHtml, rules: rulesHtml, timers: timersHtml, webhooks: webhooksHtml, ai: aiHtml, security: securityHtml, history: historyHtml, kpis: kpisHtml };

/** Panel markup for a section. @param {string} tab @param {object} ctx */
export function panelHtml(tab, ctx) { return (PANELS[tab] ?? brandingHtml)(ctx); }

/** Error badge or unsaved-change dot for one nav link. */
export function markHtml(problems = 0, changes = 0) {
  if (problems) return `<span class="badge" aria-label="${problems} problems">${problems}</span>`;
  if (changes) return `<span class="dot" role="img" aria-label="${changes} unsaved changes"></span>`;
  return '';
}

/** Left section navigation with per-section error and change counts. */
export function tabsHtml(active, report, changed = {}) {
  return TABS.map(([id, label, ic]) => `<a href="#/${id}" id="tab-${id}" data-tab="${id}" class="adm-navlink"${id === active ? ' aria-current="page"' : ''}>${icon(ic, { size: 18 })}<span class="adm-navtext">${esc(label)}</span><span class="adm-mark">${markHtml(report?.bySection?.[id] ?? 0, changed[id] ?? 0)}</span></a>`).join('');
}

const gotoLink = (p) => `<a href="#" data-goto="${esc(p.path)}" data-section="${esc(p.section)}">${esc(p.label || 'Configuration')}</a>`;

/** Warnings, each with its message and a link to the field (ADMIN-8). */
function warningsHtml(warnings) {
  if (!warnings?.length) return '';
  return `<ul class="adm-warnings">${warnings.map((w) => `<li>${gotoLink(w)}: ${esc(w.message)}</li>`).join('')}</ul>`;
}

/** Error summary shown after a failed validation; links are labelled by field name (ADMIN-6). */
export function summaryHtml(report) {
  if (!report) return '';
  const nw = report.warnings?.length ?? 0;
  if (report.valid) {
    const tone = nw ? 'warning' : 'success';
    return `<div class="fx-alert summary" data-tone="${tone}" role="status">${icon(nw ? 'alert-triangle' : 'check-circle', { size: 20 })}<div><strong>Configuration is valid${nw ? `, with ${nw} warning${nw === 1 ? '' : 's'}` : ''}</strong>${warningsHtml(report.warnings)}</div></div>`;
  }
  return `<div class="fx-alert summary" data-tone="danger" role="alert">${icon('alert-circle', { size: 20 })}<div><strong>${report.errors.length} problem${report.errors.length === 1 ? '' : 's'} to fix before saving</strong><ul>${report.errors.map((e) => `<li>${gotoLink(e)}: ${esc(e.message)}</li>`).join('')}</ul>${nw ? `<p>Also ${nw} warning${nw === 1 ? '' : 's'}:</p>${warningsHtml(report.warnings)}` : ''}</div></div>`;
}

/** Diff preview rows shown before saving, labelled by field name (ADMIN-7). @param {Array} changes from diffConfig */
export function diffHtml(changes) {
  if (!changes.length) return '<p class="muted">No changes to save.</p>';
  const cell = (c, side) => {
    if (c.kind === 'moved') return esc(side === 'before' ? (c.before === 'first' ? 'First' : `Was ${c.before}`) : describeChange(c));
    if (side === 'before') return c.kind === 'added' ? '<span class="muted">(not set)</span>' : esc(displayValue(c.before));
    return c.kind === 'removed' ? '<span class="muted">(removed)</span>' : esc(displayValue(c.after));
  };
  const rows = changes.map((c) => `<tr data-diff="${esc(c.path)}" data-kind="${esc(c.kind)}"><th scope="row">${esc(c.label ?? c.path)}<span class="adm-sec">${esc(c.kind === 'moved' ? 'Order changed' : describeChange(c) || (SECTION_LABEL[c.section] ?? 'Other'))}</span></th><td class="del">${cell(c, 'before')}</td><td class="add">${cell(c, 'after')}</td></tr>`).join('');
  return `<table class="fx-table diff-table"><caption class="fx-visually-hidden">Changes to be saved</caption><thead><tr><th scope="col">Setting</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export { toPointer };
