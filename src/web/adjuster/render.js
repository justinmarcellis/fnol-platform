// Pure render functions for the adjuster claim first view. They return HTML strings built from
// design-system components (fx-card, fx-badge, fx-timeline); every dynamic value is escaped, so
// they run and test in node without a DOM. app.js sets the fx-timeline events after painting.
import { t } from '../shared/i18n.js';
import { formatDate, formatDateTime, formatEnum, formatMoney, formatPolicyNumber, formatClaimNumber } from '../shared/format.js';
import { icon } from '../shared/icons.js';
import { timerUrgency, nextOpenTimer, partyName, severityBand as bandOf } from './model.js';

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape text for HTML content and attribute values. */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ENT[c]);
}

/** Translate a key with an enum value, falling back to a humanised token. */
function tEnum(prefix, value) {
  const key = `${prefix}.${value}`;
  const s = t(key);
  return s === key ? formatEnum(value) : s;
}

/** Locale-aware date and time in the viewer's zone. */
export const fmtWhen = (iso) => formatDateTime(iso);
/** Date-only values (YYYY-MM-DD) are calendar dates, so format them in UTC to avoid a day shift. */
const fmtDay = (v) => formatDate(v, { timeZone: 'UTC' });

/** Human duration like "2d 3h", "45m", "30s". ms is absolute. */
export function formatDuration(ms) {
  let s = Math.floor(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Timer state at `now` (kept for callers that want the legacy shape). Pure. */
export function timerState(timer, now = Date.now()) {
  const u = timerUrgency(timer, now);
  return { state: u.state, ms: u.ms, left: u.state === 'none' || u.state === 'met' ? '' : formatDuration(u.ms), tone: u.tone };
}

/** A status badge. The label always carries the meaning; tone only adds colour. */
export function badge(text, tone = 'neutral', { solid = false, attrs = '' } = {}) {
  return `<fx-badge tone="${esc(tone)}" label="${esc(text)}"${solid ? ' variant="solid"' : ''}${attrs ? ` ${attrs}` : ''}></fx-badge>`;
}

/** Severity band from a 0-100 score. */
export const severityBand = bandOf;

/** Severity badge: "Major · 62". */
export function severityChip(score, band = bandOf(score)) {
  if (!band) return badge(t('adj.severity.unknown'), 'neutral', { attrs: 'data-chip="severity"' });
  const tone = { minor: 'success', moderate: 'info', major: 'warning', severe: 'danger' }[band] ?? 'neutral';
  return badge(`${formatEnum(band)} · ${score}`, tone, { attrs: `data-chip="severity" data-band="${esc(band)}"` });
}

/** Claim status badge using the shared claim vocabulary. */
export function statusBadge(status) {
  return `<fx-badge status="${esc(status)}" kind="claim" data-chip="status"></fx-badge>`;
}

const FLAG_TONE = { siu: 'danger', fatality: 'danger', timer_breached: 'danger', injury: 'warning', coverage_question: 'warning', timer_due: 'warning', subrogation: 'info', cat: 'info' };
/** Flag badges; unknown flags show a humanised token. */
export function flagChips(flags = []) {
  return flags.map((f) => badge(tEnum('adj.flag', f), FLAG_TONE[f] ?? 'neutral', { attrs: `data-chip="flag" data-flag="${esc(f)}"` })).join(' ');
}

/** Timer label such as "Acknowledge: 2h 30m left". Pure. */
export function timerLabel(timer, now = Date.now()) {
  if (!timer) return t('adj.timer.none');
  const st = timerState(timer, now);
  const kind = tEnum('adj.timer.kind', timer.kind);
  if (st.state === 'met') return t('adj.timer.met', { kind });
  if (st.state === 'overdue') return t('adj.timer.overdue', { kind, left: st.left });
  if (st.state === 'none') return t('adj.timer.none');
  return t('adj.timer.left', { kind, left: st.left });
}

/** Timer badge, coloured by urgency, with a live-updatable data-due attribute. */
export function timerChip(timer, now = Date.now()) {
  if (!timer) return badge(t('adj.timer.none'), 'neutral', { attrs: 'data-chip="timer"' });
  const u = timerUrgency(timer, now);
  const live = ['running', 'due_soon', 'overdue'].includes(u.state);
  const kind = tEnum('adj.timer.kind', timer.kind);
  const attrs = `data-chip="timer" data-state="${esc(u.state)}"${live ? ` data-due="${esc(timer.dueAt)}" data-kind="${esc(kind)}"` : ''}`;
  return badge(timerLabel(timer, now), u.tone, { attrs, solid: u.state === 'overdue' });
}

/** Sort inbox rows: most urgent timer first, then severity (the server order; kept for local re-sorts). */
export function sortInbox(items) {
  const due = (r) => { const d = Date.parse(r.nextTimer?.dueAt); return Number.isNaN(d) ? Infinity : d; };
  return items.map((r, i) => [r, i]).sort(([a, i], [b, j]) => due(a) - due(b) || (b.severityScore ?? -1) - (a.severityScore ?? -1) || i - j).map(([r]) => r);
}

/** Key/value rows; blank values are skipped. */
function kv(pairs, cls = 'fx-kv') {
  const rows = pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v?.__html ?? esc(v)}</dd>`).join('');
  return rows ? `<dl class="${cls}">${rows}</dl>` : '';
}
/** Header facts as a responsive grid of label/value cells; blank values are skipped. */
function factsGrid(pairs) {
  return `<div class="adj-facts">${pairs.filter(([, v]) => v).map(([k, v]) => `<div class="adj-fact"><span class="adj-fact-l">${esc(k)}</span><span class="adj-fact-v">${esc(v)}</span></div>`).join('')}</div>`;
}
const raw = (html) => ({ __html: html });
const card = (id, heading, body, { sub = '', pad = '', actions = '' } = {}) =>
  `<fx-card id="panel-${id}" heading="${esc(heading)}"${sub ? ` subheading="${esc(sub)}"` : ''}${pad ? ` padding="${pad}"` : ''} level="2">${actions}${body}</fx-card>`;
const none = (key) => `<p class="adj-none">${esc(t(key))}</p>`;
const alert = (tone, title, body, extra = '') =>
  `<div class="fx-alert" data-tone="${tone}" role="note">${icon(tone === 'danger' || tone === 'warning' ? 'alert-triangle' : 'info', { size: 20 })}<div><strong>${esc(title)}</strong><p>${esc(body)}</p>${extra}</div></div>`;

/** One-line location from LossEvent.location: description, else city and state. */
export function locationText(loss) {
  const loc = loss?.location;
  if (!loc) return '';
  if (loc.description) return loc.description;
  const a = loc.address ?? {};
  return [a.line1, a.city, a.state ?? loc.state].filter(Boolean).join(', ') || (loc.state ?? '');
}

/** True when the subrogation flag should show (derived flag or triage signal). */
export function hasSubrogation(view) {
  return (view.claim?.flags ?? []).includes('subrogation') || !!view.triage?.subrogation?.flag;
}

/** Insured name for the header, from claim.parties. */
function insuredOf(claim) {
  const ps = claim?.parties ?? [];
  return partyName(ps.find((p) => (p.roles ?? []).includes('insured')) ?? ps.find((p) => p.isPolicyParty));
}

/** Claim header: status, severity, line, loss date and location, plus flag badges. */
export function headerHtml(view, now = Date.now()) {
  const c = view.claim ?? {};
  const next = nextOpenTimer(view.timers);
  const facts = factsGrid([
    [t('adj.claim.lob'), c.lob ? formatEnum(c.lob) : ''],
    [t('adj.claim.insured'), insuredOf(c)],
    [t('adj.claim.policy'), c.policyNumber ? formatPolicyNumber(c.policyNumber) : ''],
    [t('adj.claim.lossDate'), c.lossEvent?.lossDate ? fmtDay(c.lossEvent.lossDate) : ''],
    [t('adj.claim.location'), locationText(c.lossEvent)],
    [t('adj.claim.cause'), c.lossEvent?.cause ? formatEnum(c.lossEvent.cause) : ''],
    [t('adj.claim.state'), c.riskState],
    [t('adj.claim.reported'), view.timestamps?.reportedAt ? fmtWhen(view.timestamps.reportedAt) : ''],
  ]);
  const chips = [statusBadge(c.status), severityChip(view.triage?.severityScore, view.triage?.severityBand), flagChips(c.flags), timerChip(next, now)].filter(Boolean).join(' ');
  return `<fx-card id="panel-header" class="adj-hero" padding="md"><div class="fx-cluster adj-hero-chips" aria-label="${esc(t('adj.panel.header'))}" role="group">${chips}</div>${facts}</fx-card>`;
}

/** Subrogation banner shown under the header when the flag is present, else ''. */
export function subrogationBanner(view) {
  if (!hasSubrogation(view)) return '';
  const go = `<p><button class="fx-btn secondary small" type="button" data-goto="item-subrogation">${esc(t('adj.subro.banner.go'))}</button></p>`;
  return `<div id="subro-banner" data-flag="subrogation">${alert('info', t('adj.subro.banner.title'), t('adj.subro.banner.body'), go)}</div>`;
}

/** Confidence in percent (0-100) or null. */
function pctOf(ai) {
  const c = Number(ai?.confidence);
  return Number.isFinite(c) ? Math.round((c <= 1 ? c * 100 : c)) : null;
}
/** AI provenance is complete only with provider, model and a numeric confidence. */
export function hasProvenance(ai) {
  return !!(ai && ai.provider && ai.model && pctOf(ai) !== null);
}

/** Provider, model, confidence (and tier) rows. Required wherever AI output shows. */
export function provenanceHtml(ai) {
  const pct = pctOf(ai);
  const low = pct < 60;
  return kv([
    [t('adj.ai.provider'), ai.provider], [t('adj.ai.model'), ai.model],
    [t('adj.ai.confidenceLabel'), raw(badge(t('adj.ai.confidence', { pct }), low ? 'warning' : 'success', { attrs: 'data-chip="confidence"' }))],
    [t('adj.ai.tier'), ai.tier],
  ], 'fx-kv adj-prov');
}

/** Rewrite bare ISO dates (2026-03-30) and ISO timestamps in prose with the shared formatters. */
export function dateify(text) {
  return String(text ?? '').replace(/\b(\d{4}-\d{2}-\d{2})(T[\d:.]+Z?)?\b/g, (m, d, time) => (time ? formatDateTime(m) : fmtDay(d)));
}

/** Split the "Facts used:" trailer the summariser appends from the narrative. */
export function splitSummary(text) {
  const m = /\n+Facts used:\s*([\s\S]*)$/.exec(String(text ?? ''));
  return m ? { body: text.slice(0, m.index).trim(), facts: m[1].trim() } : { body: String(text ?? '').trim(), facts: '' };
}

/** AI summary card. Provider, model, confidence and explanation are always visible, never collapsed. */
export function summaryPanel(view) {
  const s = view.summary;
  const heading = t('adj.panel.summary');
  if (!s?.text) return card('summary', heading, none('adj.ai.noSummary'));
  if (!hasProvenance(s.ai)) return card('summary', heading, alert('warning', t('adj.panel.summary'), t('adj.ai.noProvenance')));
  const split = splitSummary(s.text);
  const body = dateify(split.body);
  const facts = dateify(split.facts);
  const explanation = s.explanation ?? view.triage?.explanation;
  const pct = pctOf(s.ai);
  const bullets = (s.bullets ?? []).length && !body.includes('- ') ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '';
  const text = body.split(/\n+/).map((p) => (p.startsWith('- ') ? `<li>${esc(p.slice(2))}</li>` : `<p>${esc(p)}</p>`)).join('').replace(/(<li>.*?<\/li>)+/g, (m) => `<ul>${m}</ul>`);
  return card('summary', heading, `<div id="summary-text" class="adj-summary-text">${text}${bullets}</div>
${facts ? `<details class="adj-details" id="summary-details"><summary>${esc(t('adj.ai.details'))}</summary><p class="adj-muted">${esc(t('adj.ai.facts'))}: ${esc(facts)}</p></details>` : ''}
<div class="adj-ai" id="summary-ai">${provenanceHtml(s.ai)}
<div class="adj-explain"><h3>${esc(t('adj.ai.explanation'))}</h3><p id="summary-explanation">${esc(explanation || t('adj.ai.noExplanation'))}</p></div>
${pct < 60 ? `<p class="adj-warn" role="note">${esc(t('adj.ai.lowConfidence'))}</p>` : ''}${s.unconfirmed ? `<p class="adj-warn" role="note">${esc(t('adj.ai.unconfirmed'))}</p>` : ''}</div>`,
  { sub: t('adj.ai.label') });
}

export function coveragePanel(view) {
  const c = view.coverage;
  if (!c) return card('coverage', t('adj.panel.coverage'), none('adj.coverage.none'));
  const ded = c.applicableDeductible?.amount !== undefined ? formatMoney(c.applicableDeductible) : '';
  const checks = (c.checks ?? []).map((k) => `<li class="adj-check">${badge(k.passed ? t('adj.coverage.check.pass') : t('adj.coverage.check.fail'), k.passed ? 'success' : 'danger')} <span>${esc(formatEnum(k.code))}</span>${k.detail ? ` <span class="adj-muted">${esc(k.detail)}</span>` : ''}</li>`).join('');
  return card('coverage', t('adj.panel.coverage'), `<div class="fx-stack-sm">
<div class="fx-cluster"><fx-badge status="${esc(c.outcome)}" kind="coverage" data-chip="coverage"></fx-badge></div>
${kv([[t('adj.coverage.deductible'), ded]])}
${checks ? `<ul class="adj-list">${checks}</ul>` : ''}
${(c.reasons ?? []).length ? `<ul class="adj-list adj-muted">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}</div>`);
}

/**
 * Decision state for a fraud or subrogation item from notes. A decision is a note
 * in that category whose body starts with "[decision:accepted]" or "[decision:dismissed]".
 * Notes are newest first, so the first match wins. Pure.
 * @returns {{status:'accepted'|'dismissed', note:string, actor:string, at:string}|null}
 */
export function decisionState(notes = [], kind) {
  for (const n of notes) {
    if (n.category !== kind) continue;
    const m = /^\[decision:(accepted|dismissed)\]\s*([\s\S]*)$/.exec(n.body ?? '');
    if (m) return { status: m[1], note: m[2], actor: n.author?.id ?? n.author?.name ?? '', at: n.createdAt };
  }
  return null;
}

/** Task type that mirrors each decision kind. */
export const DECISION_TASK = { fraud: 'siu_referral', subrogation: 'subrogation_review' };

/**
 * Build the requests for an accept/dismiss. Pure; the note is mandatory.
 * @returns {{ok:false,error:string}|{ok:true, note:{body:string,category:string,visibility:string}, taskPatch:null|{taskId:string,status:string}}}
 */
export function buildDecision({ kind, action, note, tasks = [] }) {
  const text = String(note ?? '').trim();
  if (!['fraud', 'subrogation'].includes(kind) || !['accepted', 'dismissed'].includes(action)) return { ok: false, error: 'invalid' };
  if (!text) return { ok: false, error: 'noteRequired' };
  const task = tasks.find((x) => x.type === DECISION_TASK[kind] && ['open', 'in_progress'].includes(x.status));
  return {
    ok: true,
    note: { body: `[decision:${action}] ${text}`, category: kind, visibility: 'internal' },
    taskPatch: task ? { taskId: task.id, status: action === 'accepted' ? 'in_progress' : 'cancelled' } : null,
  };
}

function decisionForm(kind, state) {
  if (state) {
    const key = state.status === 'accepted' ? 'adj.decision.accepted' : 'adj.decision.dismissed';
    return `<p class="decision-done" data-decision="${esc(state.status)}">${badge(t(key, { actor: state.actor }), state.status === 'accepted' ? 'success' : 'neutral')} <span>${esc(state.note)}</span></p>`;
  }
  return `<form class="decision" data-kind="${esc(kind)}" novalidate>
<label for="note-${kind}">${esc(t('adj.decision.note'))}</label>
<textarea class="fx-textarea" id="note-${kind}" name="note" rows="2" aria-describedby="hint-${kind}" required></textarea>
<p class="adj-muted" id="hint-${kind}">${esc(t('adj.decision.noteHint'))}</p>
<p class="err" role="alert" hidden></p>
<div class="fx-btn-group"><button class="fx-btn small" type="submit" data-action="accepted">${esc(t('adj.decision.accept'))}</button>
<button class="fx-btn secondary small" type="submit" data-action="dismissed">${esc(t('adj.decision.dismiss'))}</button></div></form>`;
}

export function triagePanel(view) {
  const r = view.triage;
  if (!r) return card('triage', t('adj.panel.triage'), none('adj.triage.none'));
  const fraud = r.fraud ?? { score: 0, indicators: [] };
  const sub = r.subrogation ?? { flag: false, reasons: [] };
  const fraudOpen = fraud.referToSiu || fraud.score >= 70 || (fraud.indicators ?? []).length > 0;
  const reasons = (list) => `<ul class="adj-list">${(list ?? []).map((i) => `<li><strong>${esc(formatEnum(i.code))}</strong> <span class="adj-muted">${esc(i.reason)}</span></li>`).join('')}</ul>`;
  const fraudBody = fraudOpen
    ? `<p>${badge(t('adj.triage.fraudScore', { score: fraud.score }), fraud.referToSiu ? 'danger' : 'warning')}</p>${reasons(fraud.indicators)}${decisionForm('fraud', decisionState(view.notes, 'fraud'))}`
    : `<p class="adj-none">${esc(t('adj.triage.fraud.none'))}</p>`;
  const subBody = sub.flag
    ? `${reasons(sub.reasons)}${decisionForm('subrogation', decisionState(view.notes, 'subrogation'))}`
    : `<p class="adj-none">${esc(t('adj.triage.subrogation.none'))}</p>`;
  const ai = hasProvenance(r.ai)
    ? `<div class="adj-ai adj-ai-inline" id="triage-ai"><h3>${esc(t('adj.triage.why'))}</h3><p>${esc(r.explanation || t('adj.ai.noExplanation'))}</p>${provenanceHtml(r.ai)}</div>`
    : '';
  return card('triage', t('adj.panel.triage'), `<div class="fx-stack-sm">
${kv([[t('adj.triage.severity'), raw(severityChip(r.severityScore, r.severityBand))], [t('adj.triage.complexity'), r.complexity ? formatEnum(r.complexity) : '']])}
<div class="adj-item" id="item-fraud" tabindex="-1"><h3>${esc(t('adj.triage.fraud'))}</h3>${fraudBody}</div>
<div class="adj-item" id="item-subrogation" tabindex="-1"><h3>${esc(t('adj.triage.subrogation'))}</h3>${subBody}</div>
${ai}</div>`);
}

export function routingPanel(view) {
  const r = view.routing;
  if (!r) return card('routing', t('adj.panel.routing'), none('adj.routing.none'));
  const list = (items) => `<ul class="adj-list">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  return card('routing', t('adj.panel.routing'), `<div class="fx-stack-sm">${kv([
    [t('adj.routing.outcome'), tEnum('adj.routing.outcome', r.outcome)], [t('adj.routing.queue'), r.queue ? formatEnum(r.queue) : ''],
    [t('adj.routing.adjuster'), r.adjusterId], [t('adj.routing.fastTrack'), r.fastTrack ? t('adj.yes') : t('adj.no')],
    [t('adj.routing.rules'), (r.ruleIds ?? []).length ? raw(list(r.ruleIds)) : ''], [t('adj.routing.reasons'), (r.reasons ?? []).length ? raw(list(r.reasons)) : ''],
  ])}${r.override ? `<p class="adj-warn">${esc(t('adj.routing.override', { reason: r.override.reason }))}</p>` : ''}</div>`);
}

export function timersPanel(view, now = Date.now()) {
  const list = view.timers ?? [];
  if (!list.length) return card('timers', t('adj.panel.timers'), none('adj.timers.none'));
  const items = list.map((x) => `<li>${timerChip(x, now)}<span class="adj-muted">${esc(t('adj.timers.due', { at: fmtWhen(x.dueAt) }))}${x.citation ? ` · ${esc(x.citation)}` : ''}</span></li>`).join('');
  return card('timers', t('adj.panel.timers'), `<ul class="adj-list adj-timers">${items}</ul>`);
}

/** Normalise rule priorities (high|medium|low) and AI priorities (higher number is more urgent). */
export function priorityOf(p) {
  if (typeof p === 'number') return p >= 70 ? 'high' : p >= 40 ? 'medium' : 'low';
  return ['high', 'medium', 'low'].includes(p) ? p : 'low';
}

/** Where "Go to" scrolls for a next-best-action code. */
export function actionTarget(code) {
  const c = String(code ?? '');
  if (/siu|fraud/.test(c)) return 'item-fraud';
  if (/subro|recover/.test(c)) return 'item-subrogation';
  if (/coverage|policy|deductible/.test(c)) return 'panel-coverage';
  if (/document|photo|police|report|estimate|evidence/.test(c)) return 'panel-documents';
  if (/timer|deadline|acknowledge/.test(c)) return 'panel-timers';
  return 'panel-notes';
}

/**
 * Next-best-actions as actionable rows: tick when done, jump to the place to do it. AI-sourced rows show only
 * with provenance (standards: never AI output without provider, model and confidence); otherwise they are counted, not shown.
 */
export function nbaPanel(view, done = []) {
  const all = view.nextActions ?? [];
  const shown = all.filter((a) => a.source !== 'ai' || hasProvenance(a.ai));
  const hidden = all.length - shown.length;
  const note = hidden ? `<p class="adj-muted" id="nba-hidden">${esc(t('adj.nba.aiHidden', { count: hidden }))}</p>` : '';
  if (!shown.length) return card('nba', t('adj.panel.nba'), none('adj.nba.none') + note);
  const doneSet = new Set(done);
  const n = shown.filter((a) => doneSet.has(a.code)).length;
  const items = shown.map((a, i) => {
    const pr = priorityOf(a.priority);
    const ai = a.source === 'ai' ? `${badge(t('adj.ai.suggestion'), 'brand')} <span class="adj-muted">${esc(a.ai.provider)} / ${esc(a.ai.model)} · ${pctOf(a.ai)}%</span>` : '';
    return `<li class="adj-action" data-code="${esc(a.code)}" data-priority="${pr}">
<input type="checkbox" id="nba-${i}" data-code="${esc(a.code)}"${doneSet.has(a.code) ? ' checked' : ''}>
<div class="adj-action-main"><label for="nba-${i}">${esc(a.label)}</label>
<div class="fx-cluster">${badge(tEnum('adj.nba.priority', pr), pr === 'high' ? 'danger' : pr === 'medium' ? 'warning' : 'neutral')} ${ai}</div>
${a.reason ? `<p class="adj-muted">${esc(a.reason)}</p>` : ''}</div>
<button class="fx-btn ghost small" type="button" data-goto="${actionTarget(a.code)}" aria-label="${esc(`${t('adj.nba.go')}: ${a.label}`)}">${esc(t('adj.nba.go'))}${icon('arrow-right', { size: 16 })}</button></li>`;
  }).join('');
  return card('nba', t('adj.panel.nba'), `<p class="adj-muted" role="status" id="nba-progress">${esc(t('adj.nba.progress', { done: n, total: shown.length }))}</p><ul class="adj-actions">${items}</ul>${note}`);
}

/** Parties card: name, roles, flags. */
export function partiesPanel(view) {
  const list = view.claim?.parties ?? [];
  if (!list.length) return card('parties', t('adj.panel.parties'), none('adj.parties.none'));
  const items = list.map((p) => {
    const roles = (p.roles ?? []).map((r) => formatEnum(r)).join(', ');
    const flags = [p.injured ? badge(t('adj.party.injured'), 'warning') : '', p.atFault ? badge(t('adj.party.atFault'), 'danger') : ''].filter(Boolean).join(' ');
    const contact = [p.phone, p.email].filter(Boolean).join(' · ');
    return `<li><div class="adj-line"><strong>${esc(partyName(p) || formatEnum(p.kind))}</strong>${flags ? ` ${flags}` : ''}</div><div class="adj-muted">${esc(roles)}${contact ? ` · ${esc(contact)}` : ''}</div></li>`;
  }).join('');
  return card('parties', t('adj.panel.parties'), `<ul class="adj-list">${items}</ul>`);
}

/** Vehicles card. */
export function vehiclesPanel(view) {
  const list = view.claim?.vehicles ?? [];
  if (!list.length) return card('vehicles', t('adj.panel.vehicles'), none('adj.vehicles.none'));
  const items = list.map((v) => {
    const name = [v.year, v.make, v.model].filter(Boolean).join(' ') || t('adj.vehicle.unknown');
    const flags = [v.drivable === false ? badge(t('adj.vehicle.notDrivable'), 'danger') : v.drivable === true ? badge(t('adj.vehicle.drivable'), 'success') : '', v.towed ? badge(t('adj.vehicle.towed'), 'warning') : ''].filter(Boolean).join(' ');
    const meta = [v.role ? formatEnum(v.role) : '', v.licensePlate ? `${v.licensePlate}${v.plateState ? ` (${v.plateState})` : ''}` : '', v.damageDescription].filter(Boolean).join(' · ');
    return `<li><div class="adj-line"><strong>${esc(name)}</strong>${flags ? ` ${flags}` : ''}</div><div class="adj-muted">${esc(meta)}</div></li>`;
  }).join('');
  return card('vehicles', t('adj.panel.vehicles'), `<ul class="adj-list">${items}</ul>`);
}

export function documentsPanel(view) {
  const list = view.documents ?? [];
  if (!list.length) return card('documents', t('adj.panel.documents'), none('adj.docs.none'));
  return card('documents', t('adj.panel.documents'), `<ul class="adj-list">${list.map((d) => `<li><div class="adj-line">${icon('file', { size: 16 })}<strong>${esc(d.filename ?? d.id)}</strong>${d.extraction?.needsReview ? ` ${badge(t('adj.docs.needsReview'), 'warning')}` : ''}</div><div class="adj-muted">${esc(d.kind ? formatEnum(d.kind) : '')}${d.uploadedAt ? ` · ${esc(fmtWhen(d.uploadedAt))}` : ''}</div></li>`).join('')}</ul>`);
}

export function tasksPanel(view) {
  const list = view.tasks ?? [];
  if (!list.length) return card('tasks', t('adj.panel.tasks'), none('adj.tasks.none'));
  return card('tasks', t('adj.panel.tasks'), `<ul class="adj-list">${list.map((x) => `<li><div class="adj-line"><strong>${esc(x.title)}</strong> <fx-badge status="${esc(x.status)}" kind="task"></fx-badge></div>${x.dueAt ? `<div class="adj-muted">${esc(t('adj.tasks.due', { at: fmtWhen(x.dueAt) }))}</div>` : ''}</li>`).join('')}</ul>`);
}

export function notesPanel(view) {
  const list = view.notes ?? [];
  const items = list.length
    ? `<ul class="adj-list">${list.map((n) => `<li>${n.category && n.category !== 'general' ? `${badge(formatEnum(n.category), 'neutral')} ` : ''}${esc(n.body)}<div class="adj-muted">${esc(n.author?.id ?? n.author?.name ?? '')} · ${esc(fmtWhen(n.createdAt))}</div></li>`).join('')}</ul>`
    : none('adj.notes.none');
  const form = `<form class="note-form fx-stack-sm" novalidate><label for="note-new">${esc(t('adj.notes.body'))}</label><textarea class="fx-textarea" id="note-new" name="body" rows="2"></textarea>
<div><button class="fx-btn secondary small" type="submit">${esc(t('adj.notes.add'))}</button></div></form>`;
  return card('notes', t('adj.panel.notes'), `<div class="fx-stack-sm">${items}${form}</div>`);
}

/** Audit timeline events for fx-timeline. AI events carry provider, model and confidence in `actor`. Pure. */
export function timelineEvents(view) {
  return (view.timeline ?? []).filter((e) => e.at).map((e) => {
    const type = String(e.type ?? '');
    const tone = /breach|overdue/.test(type + e.label) ? 'danger' : /triage/.test(type) ? 'info' : /routed|status/.test(type) ? 'brand' : /met|ack/.test(type) ? 'success' : 'neutral';
    const ai = /triage/.test(type) && hasProvenance(view.triage?.ai) ? t('adj.timeline.ai', { provider: view.triage.ai.provider, model: view.triage.ai.model, pct: pctOf(view.triage.ai) }) : undefined;
    const label = e.label && e.label !== type ? e.label.replace(/^Audit: (.+)$/, (_, a) => `Audit: ${formatEnum(a)}`) : formatEnum(type.replace(/^audit\./, 'audit '));
    return { at: e.at, title: label, tone, ...(ai ? { actor: ai } : {}) };
  });
}

const TIMELINE_RECENT = 12;
export function timelinePanel(view) {
  const events = timelineEvents(view);
  if (!events.length) return card('timeline', t('adj.panel.timeline'), none('adj.timeline.empty'));
  const sorted = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const recent = sorted.slice(0, TIMELINE_RECENT);
  const older = sorted.slice(TIMELINE_RECENT);
  const tl = (list) => `<fx-timeline data-events="${esc(JSON.stringify(list))}"></fx-timeline>`;
  const more = older.length ? `<details class="adj-older"><summary>${esc(t('adj.timeline.older', { count: older.length }))}</summary>${tl(older)}</details>` : '';
  return card('timeline', t('adj.panel.timeline'), tl(recent) + more);
}

/** Header, subrogation banner and the two-column panel grid in display order. */
export function claimViewHtml(view, { now = Date.now(), done = [] } = {}) {
  return `${headerHtml(view, now)}${subrogationBanner(view)}
<div class="fx-grid-main adj-grid">
<div class="fx-stack">${summaryPanel(view)}${nbaPanel(view, done)}${triagePanel(view)}${timelinePanel(view)}${notesPanel(view)}</div>
<div class="fx-stack">${timersPanel(view, now)}${partiesPanel(view)}${vehiclesPanel(view)}${coveragePanel(view)}${documentsPanel(view)}${routingPanel(view)}${tasksPanel(view)}</div>
</div>`;
}

/** Page heading text for a claim. */
export function claimHeading(view) {
  const c = view.claim ?? {};
  return t('adj.claim.heading.short', { number: c.claimNumber ? formatClaimNumber(c.claimNumber) : c.id });
}

/** Page subheading: line and loss date. */
export function claimSubheading(view) {
  const c = view.claim ?? {};
  return t('adj.claim.subheading', { line: c.lob ? formatEnum(c.lob) : '', date: c.lossEvent?.lossDate ? fmtDay(c.lossEvent.lossDate) : '' });
}
