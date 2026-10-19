// Pure render functions for the adjuster app. They return HTML strings (every
// dynamic value escaped) so they run and test in node without a DOM.
import { t, getLocale } from '../shared/i18n.js';

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape text for HTML content and attribute values. */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ENT[c]);
}

/** Translate a key with an enum value, falling back to the raw value. */
function tEnum(prefix, value) {
  const key = `${prefix}.${value}`;
  const s = t(key);
  return s === key ? String(value ?? '') : s;
}

/** Locale-aware UTC date/time. */
export function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(d);
}

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

/**
 * Timer state at `now`. Pure.
 * @returns {{state:'none'|'met'|'overdue'|'due_soon'|'running', ms:number, left:string, tone:string}}
 */
export function timerState(timer, now = Date.now()) {
  if (!timer) return { state: 'none', ms: 0, left: '', tone: 'neutral' };
  if (timer.status === 'met') return { state: 'met', ms: 0, left: '', tone: 'ok' };
  if (timer.status === 'cancelled') return { state: 'none', ms: 0, left: '', tone: 'neutral' };
  const due = Date.parse(timer.dueAt);
  const ms = Number.isNaN(due) ? 0 : due - now;
  const overdue = timer.status === 'breached' || (!Number.isNaN(due) && ms < 0);
  if (overdue) return { state: 'overdue', ms, left: formatDuration(ms), tone: 'danger' };
  const dueSoon = timer.status === 'due_soon' || (timer.warnAt && Date.parse(timer.warnAt) <= now);
  return { state: dueSoon ? 'due_soon' : 'running', ms, left: formatDuration(ms), tone: dueSoon ? 'warn' : 'neutral' };
}

/** A status chip. The text always carries the meaning; tone only adds colour. */
export function chip(text, tone = 'neutral', extra = '') {
  return `<span class="chip chip-${esc(tone)}"${extra}>${esc(text)}</span>`;
}

/** Severity chip from a 0-100 score. Bands: 0-24 minor, 25-49 moderate, 50-74 major, 75+ severe. */
export function severityBand(score) {
  if (!Number.isFinite(score)) return null;
  return score >= 75 ? 'severe' : score >= 50 ? 'major' : score >= 25 ? 'moderate' : 'minor';
}
export function severityChip(score, band = severityBand(score)) {
  if (!band) return chip(t('adj.severity.unknown'), 'neutral', ' data-chip="severity"');
  const tone = band === 'severe' ? 'danger' : band === 'major' ? 'warn' : 'neutral';
  const label = `${t('adj.severity', { score })} (${t(`adj.severity.${band}`)})`;
  return chip(label, tone, ` data-chip="severity"`);
}

const FLAG_TONE = { siu: 'danger', fatality: 'danger', timer_breached: 'danger', injury: 'warn', coverage_question: 'warn', timer_due: 'warn', subrogation: 'info', cat: 'info' };
/** Flag chips; unknown flags show their raw code. */
export function flagChips(flags = []) {
  return flags.map((f) => chip(tEnum('adj.flag', f), FLAG_TONE[f] ?? 'neutral', ` data-chip="flag" data-flag="${esc(f)}"`)).join(' ');
}

/** Timer chip with live-updatable data-due attribute. */
export function timerChip(timer, now = Date.now()) {
  if (!timer) return chip(t('adj.timer.none'), 'neutral', ' data-chip="timer"');
  const st = timerState(timer, now);
  const kind = tEnum('adj.timer.kind', timer.kind);
  let text;
  if (st.state === 'met') text = t('adj.timer.met', { kind });
  else if (st.state === 'overdue') text = t('adj.timer.overdue', { kind, left: st.left });
  else if (st.state === 'none') text = t('adj.timer.none');
  else text = t('adj.timer.left', { kind, left: st.left });
  const live = st.state === 'running' || st.state === 'due_soon' || st.state === 'overdue';
  const attrs = ` data-chip="timer"${live ? ` data-due="${esc(timer.dueAt)}" data-kind="${esc(kind)}"` : ''}`;
  return chip(text, st.tone, attrs);
}

/** Sort inbox rows: most urgent timer first, then severity (the server order; kept for local re-sorts). */
export function sortInbox(items) {
  const due = (r) => { const d = Date.parse(r.nextTimer?.dueAt); return Number.isNaN(d) ? Infinity : d; };
  return items.map((r, i) => [r, i]).sort(([a, i], [b, j]) => due(a) - due(b) || (b.severityScore ?? -1) - (a.severityScore ?? -1) || i - j).map(([r]) => r);
}

/** Inbox table. Each row has a real link so it works with keyboard and without script. */
export function inboxHtml(items = [], now = Date.now()) {
  if (!items.length) return `<p class="muted" id="inbox-empty">${esc(t('adj.inbox.empty'))}</p>`;
  const head = ['claim', 'severity', 'flags', 'timer', 'status', 'queue'].map((c) => `<th scope="col">${esc(t(`adj.inbox.col.${c}`))}</th>`).join('');
  const rows = items.map((r) => `<tr data-claim-id="${esc(r.claimId)}">
<th scope="row"><a href="#/claim/${esc(encodeURIComponent(r.claimId))}">${esc(r.claimNumber ?? r.claimId)}</a><div class="muted">${esc(r.lob ?? '')}</div></th>
<td>${severityChip(r.severityScore)}</td>
<td>${flagChips(r.flags) || '<span class="muted">-</span>'}</td>
<td>${timerChip(r.nextTimer, now)}</td>
<td>${esc(r.status ?? '')}</td>
<td>${esc(r.queue ?? '')}</td></tr>`).join('');
  return `<table class="inbox"><caption class="fx-visually-hidden">${esc(t('adj.inbox.heading'))}</caption><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

/** Definition list rows. */
function dl(pairs) {
  return `<dl>${pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v?.__html ?? esc(v)}</dd>`).join('')}</dl>`;
}
const raw = (html) => ({ __html: html });
const panel = (id, title, body) => `<section class="panel" id="panel-${id}" aria-labelledby="h-${id}"><h3 id="h-${id}">${esc(title)}</h3>${body}</section>`;
const empty = (key = 'adj.empty') => `<p class="muted">${esc(t(key))}</p>`;

/** Claim header. */
export function headerHtml(view, now = Date.now()) {
  const c = view.claim ?? {};
  const next = [...(view.timers ?? [])].filter((x) => !['met', 'cancelled'].includes(x.status)).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0];
  return `<h2 id="claim-h" tabindex="-1">${esc(t('adj.claim.heading', { number: c.claimNumber ?? c.id }))}</h2>
<p class="chips">${severityChip(view.triage?.severityScore, view.triage?.severityBand)} ${flagChips(c.flags)} ${timerChip(next, now)}</p>
${dl([[t('adj.claim.status'), c.status], [t('adj.claim.lob'), c.lob], [t('adj.claim.policy'), c.policyNumber], [t('adj.claim.state'), c.riskState],
    [t('adj.claim.lossDate'), c.lossEvent?.lossDate], [t('adj.claim.loss'), c.lossEvent?.cause]])}
<p class="muted">${esc(t('adj.claim.generated', { at: fmtWhen(view.generatedAt) }))}</p>`;
}

/** AI provenance explain block (provider, model, tier, confidence). Required wherever AI output shows. */
export function aiExplainHtml(ai, text, title = t('adj.ai.explain')) {
  if (!ai) return '';
  const pct = Math.round((Number(ai.confidence) || 0) * 100);
  const tier = ai.tier !== undefined ? dl([[t('adj.ai.tier'), ai.tier]]) : '';
  const low = pct < 60 ? `<p class="warn-text" role="note">${esc(t('adj.ai.lowConfidence'))}</p>` : '';
  return `<details class="explain"><summary>${esc(title)}</summary>
${text ? `<p>${esc(text)}</p>` : ''}
${dl([[t('adj.ai.provider'), ai.provider], [t('adj.ai.model'), ai.model]])}${tier}
<p>${chip(t('adj.ai.confidence', { pct }), pct < 60 ? 'warn' : 'ok')}</p>${low}</details>`;
}

export function summaryPanel(view) {
  const s = view.summary;
  if (!s?.text) return panel('summary', t('adj.panel.summary'), empty('adj.ai.noSummary'));
  return panel('summary', t('adj.panel.summary'),
    `<p class="muted">${esc(t('adj.ai.label'))}</p><p id="summary-text">${esc(s.text)}</p>${aiExplainHtml(s.ai, view.triage?.explanation)}`);
}

export function coveragePanel(view) {
  const c = view.coverage;
  if (!c) return panel('coverage', t('adj.panel.coverage'), empty('adj.coverage.none'));
  const tone = c.outcome === 'covered' ? 'ok' : c.outcome === 'partial' || c.outcome === 'needs_review' ? 'warn' : 'danger';
  const checks = (c.checks ?? []).map((k) => `<li>${esc(k.code)}: ${esc(k.passed ? t('adj.coverage.check.pass') : t('adj.coverage.check.fail'))}${k.detail ? ` <span class="muted">${esc(k.detail)}</span>` : ''}</li>`).join('');
  const ded = c.applicableDeductible ? `${c.applicableDeductible.amount ?? ''} ${c.applicableDeductible.currency ?? ''}`.trim() : '';
  return panel('coverage', t('adj.panel.coverage'),
    `<p>${esc(t('adj.coverage.outcome'))}: ${chip(tEnum('adj.coverage.outcome', c.outcome), tone)}</p>
${ded ? dl([[t('adj.coverage.deductible'), ded]]) : ''}${checks ? `<ul>${checks}</ul>` : ''}
${(c.reasons ?? []).length ? `<ul>${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}`);
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
    return `<p class="decision-done" data-decision="${esc(state.status)}">${chip(t(key, { actor: state.actor }), state.status === 'accepted' ? 'ok' : 'neutral')} <span>${esc(state.note)}</span></p>`;
  }
  return `<form class="decision" data-kind="${esc(kind)}" novalidate>
<label for="note-${kind}">${esc(t('adj.decision.note'))}</label>
<textarea id="note-${kind}" name="note" rows="2" aria-describedby="hint-${kind}" required></textarea>
<p class="muted" id="hint-${kind}">${esc(t('adj.decision.noteHint'))}</p>
<p class="err" role="alert" hidden></p>
<button class="fx-btn" type="submit" data-action="accepted">${esc(t('adj.decision.accept'))}</button>
<button class="fx-btn secondary" type="submit" data-action="dismissed">${esc(t('adj.decision.dismiss'))}</button></form>`;
}

export function triagePanel(view) {
  const r = view.triage;
  if (!r) return panel('triage', t('adj.panel.triage'), empty('adj.triage.none'));
  const fraud = r.fraud ?? { score: 0, indicators: [] };
  const sub = r.subrogation ?? { flag: false, reasons: [] };
  const fraudOpen = fraud.referToSiu || fraud.score >= 70 || (fraud.indicators ?? []).length > 0;
  const fraudBody = fraudOpen
    ? `<p>${chip(t('adj.triage.fraudScore', { score: fraud.score }), fraud.referToSiu ? 'danger' : 'warn')}</p>
<ul>${(fraud.indicators ?? []).map((i) => `<li><strong>${esc(i.code)}</strong>: ${esc(i.reason)}</li>`).join('')}</ul>${decisionForm('fraud', decisionState(view.notes, 'fraud'))}`
    : `<p class="muted">${esc(t('adj.triage.fraud.none'))}</p>`;
  const subBody = sub.flag
    ? `<ul>${(sub.reasons ?? []).map((i) => `<li><strong>${esc(i.code)}</strong>: ${esc(i.reason)}</li>`).join('')}</ul>${decisionForm('subrogation', decisionState(view.notes, 'subrogation'))}`
    : `<p class="muted">${esc(t('adj.triage.subrogation.none'))}</p>`;
  return panel('triage', t('adj.panel.triage'),
    `${dl([[t('adj.triage.severity'), `${r.severityScore} (${tEnum('adj.severity', r.severityBand)})`], [t('adj.triage.complexity'), r.complexity]])}
<div class="item" id="item-fraud"><h4>${esc(t('adj.triage.fraud'))}</h4>${fraudBody}</div>
<div class="item" id="item-subrogation"><h4>${esc(t('adj.triage.subrogation'))}</h4>${subBody}</div>
${aiExplainHtml(r.ai, r.explanation, t('adj.triage.why'))}`);
}

export function routingPanel(view) {
  const r = view.routing;
  if (!r) return panel('routing', t('adj.panel.routing'), empty('adj.routing.none'));
  const rules = (r.ruleIds ?? []).length ? `<ul>${r.ruleIds.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const reasons = (r.reasons ?? []).length ? `<ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  return panel('routing', t('adj.panel.routing'),
    `${dl([[t('adj.routing.outcome'), tEnum('adj.routing.outcome', r.outcome)], [t('adj.routing.queue'), r.queue], [t('adj.routing.adjuster'), r.adjusterId],
      [t('adj.routing.fastTrack'), r.fastTrack ? t('adj.yes') : t('adj.no')]])}
${rules ? `<h4>${esc(t('adj.routing.rules'))}</h4>${rules}` : ''}${reasons ? `<h4>${esc(t('adj.routing.reasons'))}</h4>${reasons}` : ''}
${r.override ? `<p class="warn-text">${esc(t('adj.routing.override', { reason: r.override.reason }))}</p>` : ''}`);
}

export function timersPanel(view, now = Date.now()) {
  const list = view.timers ?? [];
  if (!list.length) return panel('timers', t('adj.panel.timers'), empty('adj.timers.none'));
  const items = list.map((x) => `<li>${timerChip(x, now)} <span class="muted">${esc(tEnum('adj.timer.status', x.status))}, ${esc(t('adj.timers.due', { at: fmtWhen(x.dueAt) }))}${x.citation ? `, ${esc(x.citation)}` : ''}</span></li>`).join('');
  return panel('timers', t('adj.panel.timers'), `<ul class="plain">${items}</ul>`);
}

/** NBA checklist. `done` is a Set/array of action codes the adjuster ticked locally. */
export function nbaPanel(view, done = []) {
  const acts = view.nextActions ?? [];
  if (!acts.length) return panel('nba', t('adj.panel.nba'), empty('adj.nba.none'));
  const doneSet = new Set(done);
  const n = acts.filter((a) => doneSet.has(a.code)).length;
  const items = acts.map((a, i) => `<li><input type="checkbox" id="nba-${i}" data-code="${esc(a.code)}"${doneSet.has(a.code) ? ' checked' : ''}>
<label for="nba-${i}">${esc(a.label)}</label> ${chip(tEnum('adj.nba.priority', a.priority ?? 'low'), a.priority === 'high' ? 'warn' : 'neutral')} ${a.source ? chip(tEnum('adj.nba.source', a.source), 'neutral') : ''}
${a.reason ? `<div class="muted">${esc(a.reason)}</div>` : ''}</li>`).join('');
  return panel('nba', t('adj.panel.nba'), `<p class="muted" role="status" id="nba-progress">${esc(t('adj.nba.progress', { done: n, total: acts.length }))}</p><ul class="plain checklist">${items}</ul>`);
}

export function documentsPanel(view) {
  const list = view.documents ?? [];
  if (!list.length) return panel('documents', t('adj.panel.documents'), empty('adj.docs.none'));
  return panel('documents', t('adj.panel.documents'), `<ul>${list.map((d) => `<li>${esc(d.filename ?? d.id)} <span class="muted">${esc(d.kind ?? '')}</span>${d.extraction?.needsReview ? ` ${chip(t('adj.docs.needsReview'), 'warn')}` : ''}</li>`).join('')}</ul>`);
}

export function tasksPanel(view) {
  const list = view.tasks ?? [];
  if (!list.length) return panel('tasks', t('adj.panel.tasks'), empty('adj.tasks.none'));
  return panel('tasks', t('adj.panel.tasks'), `<ul>${list.map((x) => `<li>${esc(x.title)} ${chip(x.status, x.status === 'done' ? 'ok' : 'neutral')}${x.dueAt ? ` <span class="muted">${esc(fmtWhen(x.dueAt))}</span>` : ''}</li>`).join('')}</ul>`);
}

export function notesPanel(view) {
  const list = view.notes ?? [];
  const items = list.length
    ? `<ul>${list.map((n) => `<li>${n.category && n.category !== 'general' ? chip(n.category, 'neutral') + ' ' : ''}${esc(n.body)} <span class="muted">${esc(n.author?.id ?? n.author?.name ?? '')} ${esc(fmtWhen(n.createdAt))}</span></li>`).join('')}</ul>`
    : empty('adj.notes.none');
  const form = `<form class="note-form" novalidate><label for="note-new">${esc(t('adj.notes.body'))}</label><textarea id="note-new" name="body" rows="2"></textarea>
<button class="fx-btn secondary" type="submit">${esc(t('adj.notes.add'))}</button></form>`;
  return panel('notes', t('adj.panel.notes'), items + form);
}

export function timelinePanel(view) {
  const list = view.timeline ?? [];
  if (!list.length) return panel('timeline', t('adj.panel.timeline'), empty());
  return panel('timeline', t('adj.panel.timeline'), `<ol class="plain">${list.map((e) => `<li><time datetime="${esc(e.at)}">${esc(fmtWhen(e.at))}</time> ${esc(e.label ?? e.type)}</li>`).join('')}</ol>`);
}

/** Every panel in display order. */
export function claimViewHtml(view, { now = Date.now(), done = [] } = {}) {
  return `<div class="claim-head">${headerHtml(view, now)}</div>
<div class="grid">
${summaryPanel(view)}${nbaPanel(view, done)}${triagePanel(view)}${coveragePanel(view)}${routingPanel(view)}${timersPanel(view, now)}
${documentsPanel(view)}${tasksPanel(view)}${notesPanel(view)}${timelinePanel(view)}
</div>`;
}
