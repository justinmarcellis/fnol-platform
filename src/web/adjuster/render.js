// Pure render functions for the adjuster claim first view. They return HTML strings built from
// design-system components (fx-card, fx-badge, fx-timeline); every dynamic value is escaped, so
// they run and test in node without a DOM. app.js sets the fx-timeline events after painting.
//
// Labels: every code (status, cause, coverage, check, flag, fraud indicator, queue, rule, actor id) goes
// through a string table or the directory (GET /adjuster/directory) before it reaches the page. Text that
// the server writes in English (AI summary, triage explanation, timer citations, routing reasons) is marked
// lang="en" so assistive tech reads it correctly in the Spanish UI.
import { t, getLocale, resolveText } from '../shared/i18n.js';
import { formatDate, formatDateTime, formatEnum, formatMoney, formatPolicyNumber, formatClaimNumber, humanize } from '../shared/format.js';
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
/** Translate a code with a lower-case key (LATE_REPORT -> adj.fraud.late_report), else humanise it in sentence case. */
function tCode(prefix, code) {
  const c = String(code ?? '');
  const key = `${prefix}.${c.toLowerCase()}`;
  const s = t(key);
  return s === key ? humanize(c.toLowerCase()) : s;
}
/** English server text inside the Spanish UI keeps lang="en". */
const enAttr = () => (getLocale() === 'en' ? '' : ' lang="en"');

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

// ---- directory lookups (names for ids; GET /adjuster/directory)

const EMPTY_DIR = { people: {}, queues: [], rules: {} };
/** Display name for a user id or a Note/Task actor object. Unknown ids show as-is; system actors read "Platform". */
export function personName(dir, who) {
  const d = dir ?? EMPTY_DIR;
  if (!who) return '';
  if (typeof who === 'object') {
    if (who.type === 'system' || who.role === 'system') return t('adj.actor.system');
    if (who.name) return who.name;
    return personName(d, who.id);
  }
  return d.people?.[who] ?? who;
}
/** Queue label from the tenant config (I18nText), else a translated or humanised token. */
export function queueLabel(dir, id) {
  if (!id) return '';
  const q = (dir ?? EMPTY_DIR).queues?.find((x) => x.id === id);
  return q?.label ? resolveText(q.label) : tEnum('adj.queue', id);
}
/** Readable rule name, or '' when the directory does not know the rule (the id is never shown). */
export function ruleName(dir, id) {
  return (dir ?? EMPTY_DIR).rules?.[id] ?? '';
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
const yesNo = (v) => (v === true ? t('adj.yes') : v === false ? t('adj.no') : '');
const TERMINAL = ['closed', 'withdrawn'];
/** True when the claim is closed or withdrawn: the view is read-only. */
export const isReadOnly = (view) => TERMINAL.includes(view?.claim?.status);

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
    [t('adj.claim.cause'), c.lossEvent?.cause ? tEnum('adj.cause', c.lossEvent.cause) : ''],
    [t('adj.claim.state'), c.riskState],
    [t('adj.claim.reported'), view.timestamps?.reportedAt ? fmtWhen(view.timestamps.reportedAt) : ''],
    // S6-RA-03: intake answers with no claim field (police report number, drivable, damaged areas...).
    ...Object.entries(c.lossEvent?.intakeAnswers ?? {}).map(([k, v]) => [formatEnum(k), Array.isArray(v) ? v.map((x) => formatEnum(String(x))).join(', ')
      : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : typeof v === 'string' && /^[a-z]+(_[a-z]+)*$/.test(v) ? formatEnum(v) : String(v)]),
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

/** Readable model tier: 0 on-platform rules, 1 fast model, 2 strong model. */
export function tierLabel(tier) {
  if (tier === undefined || tier === null || tier === '') return '';
  return tEnum('adj.ai.tier', tier);
}

/** Provider, model, confidence (and tier) rows. Required wherever AI output shows. */
export function provenanceHtml(ai) {
  const pct = pctOf(ai);
  const low = pct < 60;
  return kv([
    [t('adj.ai.provider'), ai.provider], [t('adj.ai.model'), ai.model],
    [t('adj.ai.confidenceLabel'), raw(badge(t('adj.ai.confidence', { pct }), low ? 'warning' : 'success', { attrs: 'data-chip="confidence"' }))],
    [t('adj.ai.tier'), tierLabel(ai.tier)],
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

/**
 * Why a person must confirm AI output. The `unconfirmed` flag comes from the carrier's humanConfirmRequired
 * setting or the AI token budget (src/ai/cascade.mjs), never from low confidence, so the note says that.
 */
export function unconfirmedText(s) {
  return s?.unconfirmedReason === 'budget' ? t('adj.ai.unconfirmed.budget') : t('adj.ai.unconfirmed.policy');
}

/** Readable "Facts used" list from summary.citedFacts: labelled names and formatted values (no raw codes). */
export function citedFactsText(facts = []) {
  const value = (name, v) => {
    if (typeof v === 'boolean') return v ? t('adj.yes') : t('adj.no');
    if (typeof v !== 'string') return String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return dateify(v);
    if (['lossType', 'lossCause'].includes(name)) return tEnum('adj.cause', v);
    if (name === 'coverageOutcome') return tEnum('adj.coverage.outcome', v);
    if (name === 'claimNumber' || name === 'policeReportNumber') return v;
    return formatEnum(v);
  };
  return facts.filter((f) => f?.name).map((f) => `${tCode('adj.fact', f.name)}: ${value(f.name, f.value)}`).join('; ');
}

/** AI summary card. Provider, model, confidence and explanation are always visible, never collapsed. */
export function summaryPanel(view) {
  const s = view.summary;
  const heading = t('adj.panel.summary');
  if (!s?.text) return card('summary', heading, none('adj.ai.noSummary'));
  if (!hasProvenance(s.ai)) return card('summary', heading, alert('warning', t('adj.panel.summary'), t('adj.ai.noProvenance')));
  const split = splitSummary(s.text);
  const body = dateify(split.body);
  const facts = (s.citedFacts ?? []).length ? citedFactsText(s.citedFacts) : dateify(split.facts);
  const explanation = s.explanation ?? view.triage?.explanation;
  const pct = pctOf(s.ai);
  const bullets = (s.bullets ?? []).length && !body.includes('- ') ? `<ul>${s.bullets.map((b) => `<li>${esc(dateify(b))}</li>`).join('')}</ul>` : '';
  const text = body.split(/\n+/).map((p) => (p.startsWith('- ') ? `<li>${esc(p.slice(2))}</li>` : `<p>${esc(p)}</p>`)).join('').replace(/(<li>.*?<\/li>)+/g, (m) => `<ul>${m}</ul>`);
  const english = getLocale() === 'en' ? '' : `<p class="adj-muted" id="summary-lang">${esc(t('adj.ai.englishOnly'))}</p>`;
  const notes = [
    pct < 60 ? `<p class="adj-warn" role="note" id="summary-low">${esc(t('adj.ai.lowConfidence'))}</p>` : '',
    s.unconfirmed ? `<p class="adj-muted" role="note" id="summary-confirm">${icon('info', { size: 16 })} ${esc(unconfirmedText(s))}</p>` : '',
  ].join('');
  return card('summary', heading, `<div id="summary-text" class="adj-summary-text"${enAttr()}>${text}${bullets}</div>${english}
${facts ? `<details class="adj-details" id="summary-details"><summary>${esc(t('adj.ai.details'))}</summary><p class="adj-muted">${esc(t('adj.ai.facts'))}: ${esc(facts)}</p></details>` : ''}
<div class="adj-ai" id="summary-ai">${provenanceHtml(s.ai)}
<div class="adj-explain"><h3>${esc(t('adj.ai.explanation'))}</h3><p id="summary-explanation"${explanation ? enAttr() : ''}>${esc(explanation || t('adj.ai.noExplanation'))}</p></div>
${notes}</div>`,
  { sub: t('adj.ai.label') });
}

// ---- policy and coverage

/** Coverage name for a code: translated table, then the policy's own description, then a humanised code. */
export function coverageName(code, policy) {
  const key = `adj.cov.${code}`;
  const s = t(key);
  if (s !== key) return s;
  const all = [...(policy?.coverages ?? []), ...(policy?.vehicles ?? []).flatMap((v) => v.coverages ?? []), ...(policy?.properties ?? []).flatMap((p) => p.coverages ?? [])];
  return all.find((c) => c.code === code)?.description ?? humanize(String(code).toLowerCase());
}
const money = (m) => (m && m.amount !== undefined ? formatMoney(m, { cents: false }) : '');
/** Limit text: a single limit, or per person / per occurrence. */
export function limitText(c) {
  const parts = [];
  if (c.limitPerPerson) parts.push(t('adj.policy.perPerson', { amount: money(c.limitPerPerson) }));
  if (c.limitPerOccurrence) parts.push(t('adj.policy.perOccurrence', { amount: money(c.limitPerOccurrence) }));
  if (!parts.length && c.limit) parts.push(money(c.limit));
  return parts.join(' / ');
}
function coverageRows(list, policy, matched) {
  return list.map((c) => {
    const applies = matched.has(c.code);
    const excl = (c.excludedPerils ?? []).length ? `<div class="adj-muted">${esc(t('adj.policy.excludes', { perils: c.excludedPerils.map((x) => tEnum('adj.cause', x)).join(', ') }))}</div>` : '';
    return `<tr data-coverage="${esc(c.code)}"><th scope="row">${esc(coverageName(c.code, policy))}${applies ? ` ${badge(t('adj.policy.applies'), 'success', { attrs: 'data-chip="applies"' })}` : ''}${excl}</th><td>${esc(limitText(c) || '—')}</td><td>${esc(c.deductible ? money(c.deductible) : '—')}</td></tr>`;
  }).join('');
}

/** The policy unit (vehicle or location) the claim is about, matched by policy id, VIN or the only one. */
function claimedUnit(view) {
  const p = view.policy ?? {};
  const cv = (view.claim?.vehicles ?? []).find((v) => v.role === 'insured') ?? view.claim?.vehicles?.[0];
  const cp = (view.claim?.properties ?? []).find((x) => x.role === 'insured_location') ?? view.claim?.properties?.[0];
  if (cv && (p.vehicles ?? []).length) {
    const v = p.vehicles.find((x) => x.unitId === cv.policyVehicleId || (cv.vin && x.vin === cv.vin)) ?? (p.vehicles.length === 1 ? p.vehicles[0] : null);
    if (v) return { label: t('adj.policy.vehicle', { name: [v.year, v.make, v.model].filter(Boolean).join(' ') }), coverages: v.coverages ?? [] };
  }
  if (cp && (p.properties ?? []).length) {
    const x = p.properties.find((y) => y.locationId === cp.policyLocationId) ?? (p.properties.length === 1 ? p.properties[0] : null);
    if (x) return { label: t('adj.policy.location', { type: x.dwellingType ? tEnum('adj.dwelling', x.dwellingType) : '' }).trim(), coverages: x.coverages ?? [] };
  }
  return null;
}

/** Policy card: term, status, named insured, coverages with limits and deductibles, endorsements. */
export function policyPanel(view) {
  const p = view.policy;
  if (!p) return card('policy', t('adj.panel.policy'), none('adj.policy.none'));
  const matched = new Set([...(view.coverage?.matchedCoverages ?? []), ...(view.coverage?.applicableCoverages ?? [])]);
  const term = p.period?.effectiveDate ? t('adj.policy.termRange', { from: fmtDay(p.period.effectiveDate), to: p.period.expirationDate ? fmtDay(p.period.expirationDate) : '—' }) : '';
  const insureds = (p.namedInsureds ?? []).map((n) => n.name).filter(Boolean).join(', ');
  const unit = claimedUnit(view);
  const head = `<thead><tr><th scope="col">${esc(t('adj.policy.coverage'))}</th><th scope="col">${esc(t('adj.policy.limit'))}</th><th scope="col">${esc(t('adj.coverage.deductible'))}</th></tr></thead>`;
  const table = (list, caption) => (list.length ? `<div class="adj-table-wrap"><table class="adj-cov-table"><caption>${esc(caption)}</caption>${head}<tbody>${coverageRows(list, p, matched)}</tbody></table></div>` : '');
  const ends = (p.endorsements ?? []).length
    ? `<h3>${esc(t('adj.policy.endorsements'))}</h3><ul class="adj-list" id="policy-endorsements">${p.endorsements.map((e) => `<li><strong>${esc(e.code)}</strong> <span class="adj-muted">${esc(e.description ?? '')}</span></li>`).join('')}</ul>`
    : `<p class="adj-muted">${esc(t('adj.policy.noEndorsements'))}</p>`;
  return card('policy', t('adj.panel.policy'), `<div class="fx-stack-sm">${kv([
    [t('adj.policy.number'), p.policyNumber ? formatPolicyNumber(p.policyNumber) : ''],
    [t('adj.policy.status'), p.status ? tEnum('adj.policy.status', p.status) : ''],
    [t('adj.policy.term'), term],
    [t('adj.policy.namedInsured'), insureds],
    [t('adj.claim.lob'), p.lob ? formatEnum(p.lob) : ''],
    [t('adj.policy.ratingState'), p.ratingState],
  ])}
${table(p.coverages ?? [], t('adj.policy.policyCoverages'))}
${unit ? table(unit.coverages, unit.label) : ''}
${ends}</div>`);
}

/** Readable detail for a coverage check, from its code and the raw detail string. */
export function checkDetail(check, policy) {
  const d = String(check.detail ?? '');
  if (!d) return '';
  switch (check.code) {
    case 'loss_in_period': {
      const m = /^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2}|.+)$/.exec(d);
      return m ? t('adj.policy.termRange', { from: fmtDay(m[1]), to: /^\d{4}/.test(m[2]) ? fmtDay(m[2]) : m[2] }) : dateify(d);
    }
    case 'in_force': {
      const m = /policy status (\w+)/.exec(d);
      return m ? t('adj.coverage.detail.status', { status: tEnum('adj.policy.status', m[1]) }) : d;
    }
    case 'coverage_present':
      return d.split(/\s+or\s+/).map((c) => coverageName(c.trim(), policy)).join(t('adj.coverage.detail.or'));
    case 'peril_covered':
      return tEnum('adj.cause', d);
    default: {
      const m = /^(\d+) of (\d+)/.exec(d);
      if (m) return t('adj.coverage.detail.matched', { hit: m[1], total: m[2] });
      return d;
    }
  }
}

/** Readable coverage reason: "covered_under: DWELLING, ..." -> "Covered under: Dwelling, ..."; other codes keep their text. */
export function reasonText(reason, policy) {
  const m = /^([a-z_]+):\s*([\s\S]*)$/.exec(String(reason ?? ''));
  if (!m) return { text: String(reason ?? ''), en: true };
  if (m[1] === 'covered_under') return { text: t('adj.coverage.reason.covered_under', { list: m[2].split(/\s*,\s*/).map((c) => coverageName(c, policy)).join(', ') }), en: false };
  const key = `adj.coverage.reason.${m[1]}`;
  const s = t(key);
  return s === key ? { text: m[2], en: true } : { text: s, en: false };
}

export function coveragePanel(view) {
  const c = view.coverage;
  if (!c) return card('coverage', t('adj.panel.coverage'), none('adj.coverage.none'));
  const ded = c.applicableDeductible?.amount !== undefined ? formatMoney(c.applicableDeductible) : '';
  const checks = (c.checks ?? []).map((k) => {
    const detail = checkDetail(k, view.policy);
    return `<li class="adj-check" data-check="${esc(k.code)}">${badge(k.passed ? t('adj.coverage.check.pass') : t('adj.coverage.check.fail'), k.passed ? 'success' : 'danger')} <span>${esc(tCode('adj.coverage.check', k.code))}</span>${detail ? ` <span class="adj-muted">${esc(detail)}</span>` : ''}</li>`;
  }).join('');
  const reasons = (c.reasons ?? []).map((r) => reasonText(r, view.policy));
  const matched = [...new Set(c.matchedCoverages ?? [])];
  return card('coverage', t('adj.panel.coverage'), `<div class="fx-stack-sm">
<div class="fx-cluster"><fx-badge status="${esc(c.outcome)}" kind="coverage" data-chip="coverage"></fx-badge></div>
${kv([[t('adj.coverage.deductible'), ded], [t('adj.coverage.matched'), matched.map((x) => coverageName(x, view.policy)).join(', ')]])}
${checks ? `<h3>${esc(t('adj.coverage.checks'))}</h3><ul class="adj-list" id="coverage-checks">${checks}</ul>` : ''}
${reasons.length ? `<ul class="adj-list adj-muted">${reasons.map((r) => `<li${r.en ? enAttr() : ''}>${esc(r.text)}</li>`).join('')}</ul>` : ''}</div>`);
}

// ---- loss details

/** Police report line: filed (agency, number), not filed, or unknown. */
export function policeReportText(le, documents = []) {
  const pr = le?.policeReport;
  const doc = documents.some((d) => d.kind === 'police_report');
  if (pr && (pr.filed === true || pr === true || pr.reportNumber || pr.number)) {
    const num = pr.reportNumber ?? pr.number;
    const parts = [pr.agency, num ? t('adj.loss.police.number', { number: num }) : ''].filter(Boolean).join(' · ');
    return parts ? t('adj.loss.police.filedWith', { details: parts }) : t('adj.loss.police.filed');
  }
  if (doc) return t('adj.loss.police.onFile');
  if (pr && pr.filed === false) return t('adj.loss.police.notFiled');
  return '';
}

/** Loss details card: the claimant's description, loss time, police report and property damage. */
export function lossPanel(view) {
  const c = view.claim ?? {};
  const le = c.lossEvent ?? {};
  const when = [le.lossDate ? fmtDay(le.lossDate) : '', le.lossTime ?? '', le.lossTimeZone ? `(${le.lossTimeZone})` : ''].filter(Boolean).join(' ');
  const narrative = le.description ? `<blockquote class="adj-quote" id="loss-description"><p>${esc(le.description)}</p></blockquote>` : `<p class="adj-none">${esc(t('adj.loss.noDescription'))}</p>`;
  const props = (c.properties ?? []).map((p) => kv([
    [t('adj.loss.dwelling'), p.dwellingType ? tEnum('adj.dwelling', p.dwellingType) : ''],
    [t('adj.loss.damagedAreas'), (p.damagedAreas ?? []).map((a) => tEnum('adj.area', a)).join(', ')],
    [t('adj.loss.damage'), p.damageDescription],
    [t('adj.loss.habitable'), yesNo(p.habitable)],
    [t('adj.loss.occupied'), yesNo(p.occupied)],
    [t('adj.loss.mitigation'), yesNo(p.mitigationStarted)],
    [t('adj.loss.emergency'), yesNo(p.emergencyServicesNeeded)],
  ])).join('');
  return card('loss', t('adj.panel.loss'), `<div class="fx-stack-sm">${narrative}${kv([
    [t('adj.loss.when'), when],
    [t('adj.claim.cause'), le.cause ? tEnum('adj.cause', le.cause) : ''],
    [t('adj.claim.location'), locationText(le)],
    [t('adj.loss.police'), policeReportText(le, view.documents ?? [])],
    [t('adj.loss.injuries'), yesNo(le.injuriesReported)],
    [t('adj.loss.vehiclesInvolved'), le.vehiclesInvolved],
  ])}${props ? `<h3>${esc(t('adj.loss.property'))}</h3>${props}` : ''}</div>`);
}

/**
 * Decision state for a fraud or subrogation item from notes. A decision is a note
 * in that category whose body starts with "[decision:accepted]" or "[decision:dismissed]".
 * Notes are newest first, so the first match wins. Pure.
 * @returns {{status:'accepted'|'dismissed', note:string, actor:string, actorId:string, at:string}|null}
 */
export function decisionState(notes = [], kind, dir) {
  for (const n of notes) {
    if (n.category !== kind) continue;
    const m = /^\[decision:(accepted|dismissed)\]\s*([\s\S]*)$/.exec(n.body ?? '');
    if (m) return { status: m[1], note: m[2], actor: personName(dir, n.author) || (n.author?.id ?? ''), actorId: n.author?.id ?? '', at: n.createdAt };
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

function decisionForm(kind, state, readOnly) {
  if (state) {
    const key = state.status === 'accepted' ? 'adj.decision.accepted' : 'adj.decision.dismissed';
    return `<p class="decision-done" data-decision="${esc(state.status)}">${badge(t(key, { actor: state.actor }), state.status === 'accepted' ? 'success' : 'neutral')} <span>${esc(state.note)}</span></p>`;
  }
  if (readOnly) return '';
  return `<form class="decision" data-kind="${esc(kind)}" novalidate>
<label for="note-${kind}">${esc(t('adj.decision.note'))}</label>
<textarea class="fx-textarea" id="note-${kind}" name="note" rows="2" aria-describedby="hint-${kind}" required></textarea>
<p class="adj-muted" id="hint-${kind}">${esc(t('adj.decision.noteHint'))}</p>
<p class="err" role="alert" hidden></p>
<div class="fx-btn-group"><button class="fx-btn small" type="submit" data-action="accepted">${esc(t('adj.decision.accept'))}</button>
<button class="fx-btn secondary small" type="submit" data-action="dismissed">${esc(t('adj.decision.dismiss'))}</button></div></form>`;
}

/** Fraud score at or above this needs an adjuster decision (same threshold as the derived 'siu' flag). */
export const FRAUD_DECISION_SCORE = 70;
/** True when the fraud item needs an accept/dismiss: a high score or an SIU referral. */
export const fraudNeedsDecision = (fraud) => !!(fraud?.referToSiu || (fraud?.score ?? 0) >= FRAUD_DECISION_SCORE);

export function triagePanel(view, { dir } = {}) {
  const r = view.triage;
  if (!r) return card('triage', t('adj.panel.triage'), none('adj.triage.none'));
  const ro = isReadOnly(view);
  const fraud = r.fraud ?? { score: 0, indicators: [] };
  const sub = r.subrogation ?? { flag: false, reasons: [] };
  const indicators = fraud.indicators ?? [];
  const needs = fraudNeedsDecision(fraud);
  const reasons = (list, prefix) => `<ul class="adj-list">${(list ?? []).map((i) => `<li><strong>${esc(tCode(prefix, i.code))}</strong> <span class="adj-muted"${enAttr()}>${esc(i.reason)}</span></li>`).join('')}</ul>`;
  const state = decisionState(view.notes, 'fraud', dir);
  let fraudBody;
  if (needs || state) fraudBody = `<p>${badge(t('adj.triage.fraudScore', { score: fraud.score }), fraud.referToSiu ? 'danger' : 'warning')}</p>${reasons(indicators, 'adj.fraud')}${decisionForm('fraud', state, ro)}`;
  else if (indicators.length) fraudBody = `<p>${badge(t('adj.triage.fraudScore', { score: fraud.score }), 'neutral')}</p>${reasons(indicators, 'adj.fraud')}<p class="adj-muted" id="fraud-low">${esc(t('adj.triage.fraud.low'))}</p>`;
  else fraudBody = `<p class="adj-none">${esc(t('adj.triage.fraud.none'))}</p>`;
  const subBody = sub.flag
    ? `${reasons(sub.reasons, 'adj.subro')}${decisionForm('subrogation', decisionState(view.notes, 'subrogation', dir), ro)}`
    : `<p class="adj-none">${esc(t('adj.triage.subrogation.none'))}</p>`;
  const ai = hasProvenance(r.ai)
    ? `<div class="adj-ai adj-ai-inline" id="triage-ai"><h3>${esc(t('adj.triage.why'))}</h3><p${r.explanation ? enAttr() : ''}>${esc(r.explanation || t('adj.ai.noExplanation'))}</p>${provenanceHtml(r.ai)}</div>`
    : '';
  return card('triage', t('adj.panel.triage'), `<div class="fx-stack-sm">
${kv([[t('adj.triage.severity'), raw(severityChip(r.severityScore, r.severityBand))], [t('adj.triage.complexity'), r.complexity ? formatEnum(r.complexity) : '']])}
<div class="adj-item" id="item-fraud" tabindex="-1"><h3>${esc(t('adj.triage.fraud'))}</h3>${fraudBody}</div>
<div class="adj-item" id="item-subrogation" tabindex="-1"><h3>${esc(t('adj.triage.subrogation'))}</h3>${subBody}</div>
${ai}</div>`);
}

/** Claim statuses a routing override can apply to (rules module ROUTABLE). */
export const ROUTABLE = ['triaged', 'assigned', 'fast_tracked'];

/** Supervisor override form: queue, adjuster, mandatory reason. */
function overrideForm(view, dir) {
  const r = view.routing ?? {};
  const queues = (dir ?? EMPTY_DIR).queues ?? [];
  if (!queues.length) return '';
  if (!ROUTABLE.includes(view.claim?.status)) {
    return `<p class="adj-muted" id="override-unavailable">${esc(t('adj.override.unavailable', { status: formatEnum(view.claim?.status) }))}</p>`;
  }
  const qOpts = queues.map((q) => `<option value="${esc(q.id)}"${q.id === r.queue ? ' selected' : ''}>${esc(resolveText(q.label) || q.id)}</option>`).join('');
  const aOpts = queues.map((q) => `<optgroup label="${esc(resolveText(q.label) || q.id)}">${(q.adjusters ?? []).map((a) => `<option value="${esc(a)}" data-queue="${esc(q.id)}"${a === r.adjusterId && q.id === r.queue ? ' selected' : ''}>${esc(personName(dir, a))}</option>`).join('')}</optgroup>`).join('');
  return `<form class="override-form fx-stack-sm" id="override-form" novalidate><h3>${esc(t('adj.override.heading'))}</h3>
<label for="override-queue">${esc(t('adj.routing.queue'))}</label><select class="fx-select" id="override-queue" name="queue">${qOpts}</select>
<label for="override-adjuster">${esc(t('adj.routing.adjuster'))}</label><select class="fx-select" id="override-adjuster" name="adjusterId"><option value="">${esc(t('adj.override.auto'))}</option>${aOpts}</select>
<label for="override-reason">${esc(t('adj.override.reason'))}</label><textarea class="fx-textarea" id="override-reason" name="reason" rows="2" required></textarea>
<p class="err" role="alert" hidden></p>
<div><button class="fx-btn small" type="submit">${esc(t('adj.override.submit'))}</button></div></form>`;
}

/** Localise one rules-engine reason phrase (src/modules/rules); unknown phrases come back unchanged. */
function reasonPhrase(text, dir) {
  const s = String(text).trim();
  let m;
  if ((m = /^route to (\S+)$/.exec(s))) return t('adj.routing.r.routeTo', { queue: queueLabel(dir, m[1]) });
  if (s === 'fast track requested') return t('adj.routing.r.ftRequested');
  if (s === 'fast track not requested') return t('adj.routing.r.ftNotRequested');
  if ((m = /^fast track denied \((.+)\)$/.exec(s))) return t('adj.routing.r.ftDenied', { why: m[1] });
  if ((m = /^fast track approved \(severity (\d+), fraud (\d+)\)$/.exec(s))) return t('adj.routing.r.ftApproved', { severity: m[1], fraud: m[2] });
  if ((m = /^fast track blocked: fraud score (\d+) above fast-track limit (\d+)$/.exec(s))) return t('adj.routing.r.ftBlocked', { score: m[1], limit: m[2] });
  if ((m = /^(\S+) queue skipped because the claim is not fast tracked$/.exec(s))) return t('adj.routing.r.queueSkipped', { queue: queueLabel(dir, m[1]) });
  return s;
}

/** Routing reasons, localised, with rule ids replaced by rule names (unknown ids dropped). */
export function routingReasons(r, dir) {
  return (r.reasons ?? []).map((x) => {
    const m = /^([A-Z][A-Z0-9-]+):\s*(.*)$/.exec(String(x));
    if (!m) return reasonPhrase(x, dir);
    const name = ruleName(dir, m[1]);
    return name ? `${name}: ${reasonPhrase(m[2], dir)}` : reasonPhrase(m[2], dir);
  });
}

export function routingPanel(view, { dir, role } = {}) {
  const r = view.routing;
  if (!r) return card('routing', t('adj.panel.routing'), none('adj.routing.none'));
  const list = (items, lang = '') => `<ul class="adj-list">${items.map((x) => `<li${lang}>${esc(x)}</li>`).join('')}</ul>`;
  const rules = (r.ruleIds ?? []).map((id) => ruleName(dir, id)).filter(Boolean);
  const reasons = routingReasons(r, dir);
  const sup = role === 'supervisor' && !isReadOnly(view) ? overrideForm(view, dir) : '';
  return card('routing', t('adj.panel.routing'), `<div class="fx-stack-sm">${kv([
    [t('adj.routing.outcome'), tEnum('adj.routing.outcome', r.outcome)], [t('adj.routing.queue'), queueLabel(dir, r.queue)],
    [t('adj.routing.adjuster'), r.adjusterId ? personName(dir, r.adjusterId) : ''], [t('adj.routing.fastTrack'), r.fastTrack ? t('adj.yes') : t('adj.no')],
    [t('adj.routing.decided'), r.decidedAt ? fmtWhen(r.decidedAt) : ''],
    [t('adj.routing.rules'), rules.length ? raw(list(rules)) : ''], [t('adj.routing.reasons'), reasons.length ? raw(list(reasons)) : ''],
  ])}${r.override ? `<p class="adj-warn">${esc(t('adj.routing.override', { reason: r.override.reason }))}</p>` : ''}${sup}</div>`);
}

export function timersPanel(view, now = Date.now()) {
  const list = view.timers ?? [];
  if (!list.length) return card('timers', t('adj.panel.timers'), none('adj.timers.none'));
  const items = list.map((x) => `<li>${timerChip(x, now)}<span class="adj-muted">${esc(t('adj.timers.due', { at: fmtWhen(x.dueAt) }))}${x.citation ? ` · <span${enAttr()}>${esc(x.citation)}</span>` : ''}</span></li>`).join('');
  return card('timers', t('adj.panel.timers'), `<ul class="adj-list adj-timers">${items}</ul>`);
}

/**
 * Normalise a priority to high | medium | low. Rule actions send the band. AI actions follow the AI contract,
 * where 1 is the highest (src/ai/providers/_shared.mjs): 1 is high, 2 medium, 3 and above low. Numbers above
 * 10 are read as a 0-100 urgency score. Same mapping as src/modules/adjuster/actions.mjs priorityBand.
 */
export function priorityOf(p) {
  if (typeof p === 'number' && Number.isFinite(p)) {
    if (p > 10) return p >= 70 ? 'high' : p >= 40 ? 'medium' : 'low';
    return p <= 1 ? 'high' : p <= 2 ? 'medium' : 'low';
  }
  return ['high', 'medium', 'low'].includes(p) ? p : 'low';
}

/** Where "Go to" scrolls for a next-best-action code: the place where the action can be done. */
export function actionTarget(code) {
  const c = String(code ?? '').toLowerCase();
  if (/siu|fraud/.test(c)) return 'item-fraud';
  if (/subro|recover/.test(c)) return 'item-subrogation';
  if (/coverage|policy|deductible/.test(c)) return 'panel-coverage';
  if (/document|photo|police|report|estimate|evidence|request/.test(c)) return 'request-form';
  if (/timer|deadline|acknowledge|contact|injur/.test(c)) return 'panel-timers';
  if (/escalate|supervisor|assign|route/.test(c)) return 'panel-routing';
  return 'panel-actions';
}

/** Localised label for a rule action (src/modules/adjuster/actions.mjs codes); AI labels stay as written. */
export function actionLabel(a) {
  if (a.source !== 'rule') return a.label;
  const m = /^timer_(\w+?)_(breached|due)$/.exec(a.code ?? '');
  if (m) return t(`adj.nba.rule.timer_${m[2]}`, { kind: tEnum('adj.timer.kind', m[1]) });
  const key = `adj.nba.rule.${a.code}`;
  const s = t(key);
  return s === key ? a.label : s;
}
/** Localised reason for a rule action when it is a fixed phrase; else the server text (marked English). */
function actionReason(a) {
  if (a.source === 'rule') {
    const key = `adj.nba.reason.${a.code}`;
    const s = t(key);
    if (s !== key) return { text: s, en: false };
    const f = /^Fraud score (\d+)$/.exec(a.reason ?? '');
    if (f) return { text: t('adj.triage.fraudScore', { score: f[1] }), en: false };
  }
  return { text: a.reason, en: true };
}

/**
 * Next-best-actions as actionable rows: tick when done, jump to the place to do it. AI-sourced rows show only
 * with provenance (standards: never AI output without provider, model and confidence); otherwise they are counted, not shown.
 */
export function nbaPanel(view, done = []) {
  if (isReadOnly(view)) return card('nba', t('adj.panel.nba'), none('adj.nba.closed'));
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
<div class="adj-action-main"><label for="nba-${i}"${a.source === 'ai' ? enAttr() : ''}>${esc(actionLabel(a))}</label>
<div class="fx-cluster">${badge(tEnum('adj.nba.priority', pr), pr === 'high' ? 'danger' : pr === 'medium' ? 'warning' : 'neutral')} ${ai}</div>
${a.reason ? (() => { const r = actionReason(a); return `<p class="adj-muted"${r.en ? enAttr() : ''}>${esc(r.text)}</p>`; })() : ''}</div>
<button class="fx-btn ghost small" type="button" data-goto="${actionTarget(a.code)}" aria-label="${esc(`${t('adj.nba.go')}: ${a.label}`)}">${esc(t('adj.nba.go'))}${icon('arrow-right', { size: 16 })}</button></li>`;
  }).join('');
  return card('nba', t('adj.panel.nba'), `<p class="adj-muted" role="status" id="nba-progress">${esc(t('adj.nba.progress', { done: n, total: shown.length }))}</p><ul class="adj-actions">${items}</ul>${note}`);
}

// ---- claim actions (status, information requests)

/** Manual status moves per role; mirrors src/modules/claims/lifecycle.mjs (the server re-checks every move). */
const MOVES = {
  assigned: { in_review: ['adjuster', 'supervisor'] },
  fast_tracked: { in_review: ['supervisor'], closed: ['supervisor'] },
  in_review: { pending_info: ['adjuster', 'supervisor'], closed: ['adjuster', 'supervisor'] },
  pending_info: { in_review: ['adjuster', 'supervisor'] },
  closed: { in_review: ['supervisor'] },
};
/** Status moves the role may make from the claim's current status. Pure. */
export function statusMoves(status, role = 'adjuster') {
  return Object.entries(MOVES[status] ?? {}).filter(([, roles]) => roles.includes(role)).map(([to]) => to);
}
export const CLOSE_REASONS = ['paid', 'denied', 'no_coverage', 'duplicate', 'withdrawn_by_insured', 'below_deductible', 'other'];
export const REQUEST_KINDS = ['estimate', 'photos', 'police_report', 'receipts', 'other'];

/** Claim actions card: move the status (closing needs a reason) and ask the claimant for information. */
export function actionsPanel(view, { role = 'adjuster' } = {}) {
  const status = view.claim?.status;
  const moves = statusMoves(status, role);
  const ro = isReadOnly(view);
  const moveBtns = moves.filter((to) => to !== 'closed').map((to) => `<button class="fx-btn secondary small" type="button" data-status-to="${esc(to)}">${esc(t(`adj.actions.to.${to}`))}</button>`).join('');
  const close = moves.includes('closed') ? `<form class="close-form fx-stack-sm" id="close-form" novalidate>
<label for="close-reason">${esc(t('adj.actions.closeReason'))}</label><select class="fx-select" id="close-reason" name="closeReason"><option value="">${esc(t('adj.actions.choose'))}</option>${CLOSE_REASONS.map((r) => `<option value="${r}">${esc(t(`adj.close.${r}`))}</option>`).join('')}</select>
<p class="err" role="alert" hidden></p><div><button class="fx-btn secondary small" type="submit">${esc(t('adj.actions.close'))}</button></div></form>` : '';
  const request = ro ? '' : `<form class="request-form fx-stack-sm" id="request-form" tabindex="-1" novalidate><h3>${esc(t('adj.request.heading'))}</h3>
<label for="request-kind">${esc(t('adj.request.kind'))}</label><select class="fx-select" id="request-kind" name="kind">${REQUEST_KINDS.map((k) => `<option value="${k}">${esc(t(`adj.request.kind.${k}`))}</option>`).join('')}</select>
<label for="request-message">${esc(t('adj.request.message'))}</label><textarea class="fx-textarea" id="request-message" name="message" rows="2" aria-describedby="request-hint"></textarea>
<p class="adj-muted" id="request-hint">${esc(t(status === 'in_review' || status === 'assigned' ? 'adj.request.hint.pending' : 'adj.request.hint'))}</p>
<p class="err" role="alert" hidden></p><div><button class="fx-btn small" type="submit">${esc(t('adj.request.submit'))}</button></div></form>`;
  const statusLine = `<p class="adj-line"><span class="adj-muted">${esc(t('adj.claim.status'))}</span> ${statusBadge(status)}</p>`;
  const moveBlock = moveBtns ? `<div class="fx-btn-group" id="status-moves">${moveBtns}</div>` : '';
  const body = moveBlock || close || request ? `${statusLine}${moveBlock}${close}${request}` : `${statusLine}${none('adj.actions.none')}`;
  return card('actions', t('adj.panel.actions'), `<div class="fx-stack-sm">${body}</div>`);
}

/** Parties card: name, roles, flags. */
export function partiesPanel(view) {
  const list = view.claim?.parties ?? [];
  if (!list.length) return card('parties', t('adj.panel.parties'), none('adj.parties.none'));
  const items = list.map((p) => {
    const roles = (p.roles ?? []).map((r) => tEnum('adj.role', r)).join(', ');
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
    const areas = (v.damageAreas ?? []).map((a) => tEnum('adj.area', a)).join(', ');
    const meta = [v.role ? tEnum('adj.role', v.role) : '', v.licensePlate ? `${v.licensePlate}${v.plateState ? ` (${v.plateState})` : ''}` : '', areas, v.damageDescription].filter(Boolean).join(' · ');
    return `<li><div class="adj-line"><strong>${esc(name)}</strong>${flags ? ` ${flags}` : ''}</div><div class="adj-muted">${esc(meta)}</div></li>`;
  }).join('');
  return card('vehicles', t('adj.panel.vehicles'), `<ul class="adj-list">${items}</ul>`);
}

export function documentsPanel(view) {
  const list = view.documents ?? [];
  if (!list.length) return card('documents', t('adj.panel.documents'), none('adj.docs.none'));
  return card('documents', t('adj.panel.documents'), `<ul class="adj-list">${list.map((d) => `<li><div class="adj-line">${icon('file', { size: 16 })}<strong>${esc(d.filename ?? d.id)}</strong>${d.extraction?.needsReview ? ` ${badge(t('adj.docs.needsReview'), 'warning')}` : ''}</div><div class="adj-muted">${esc(d.kind ? tEnum('adj.doc.kind', d.kind) : '')}${d.uploadedAt ? ` · ${esc(fmtWhen(d.uploadedAt))}` : ''}</div></li>`).join('')}</ul>`);
}

/** Tasks card. Open tasks can be started and completed (PATCH /claims/{id}/tasks/{taskId}). */
export function tasksPanel(view, { dir } = {}) {
  const list = view.tasks ?? [];
  if (!list.length) return card('tasks', t('adj.panel.tasks'), none('adj.tasks.none'));
  const ro = isReadOnly(view);
  const btn = (task, to, key, cls = 'secondary') => `<button class="fx-btn ${cls} small" type="button" data-task-id="${esc(task.id)}" data-task-status="${to}" aria-label="${esc(`${t(key)}: ${task.title}`)}">${esc(t(key))}</button>`;
  const items = list.map((x) => {
    const open = ['open', 'in_progress'].includes(x.status);
    const buttons = !ro && open ? `<div class="fx-btn-group">${x.status === 'open' ? btn(x, 'in_progress', 'adj.tasks.start') : ''}${btn(x, 'done', 'adj.tasks.done', '')}</div>` : '';
    const meta = [x.dueAt ? t('adj.tasks.due', { at: fmtWhen(x.dueAt) }) : '', x.assigneeId ? t('adj.tasks.assignee', { name: personName(dir, x.assigneeId) }) : '', x.completedAt ? t('adj.tasks.completed', { at: fmtWhen(x.completedAt) }) : ''].filter(Boolean).join(' · ');
    return `<li data-task="${esc(x.id)}"><div class="adj-line"><strong>${esc(x.title)}</strong> <fx-badge status="${esc(x.status)}" kind="task"></fx-badge></div>${meta ? `<div class="adj-muted">${esc(meta)}</div>` : ''}${buttons}</li>`;
  }).join('');
  return card('tasks', t('adj.panel.tasks'), `<ul class="adj-list">${items}</ul>`);
}

/** Note body for display: decision notes read "Fraud decision: Dismissed. <note>" instead of the stored prefix. */
export function noteText(n) {
  const m = /^\[decision:(accepted|dismissed)\]\s*([\s\S]*)$/.exec(n?.body ?? '');
  if (m && ['fraud', 'subrogation'].includes(n.category)) {
    return t('adj.notes.decision', { kind: t(`adj.notes.decision.${n.category}`), decision: t(`adj.notes.decision.${m[1]}`), note: m[2] });
  }
  return n?.body ?? '';
}

export function notesPanel(view, { dir } = {}) {
  const list = view.notes ?? [];
  const isDecision = (n) => /^\[decision:/.test(n.body ?? '') && ['fraud', 'subrogation'].includes(n.category);
  const items = list.length
    ? `<ul class="adj-list">${list.map((n) => `<li>${n.category && n.category !== 'general' && !isDecision(n) ? `${badge(tEnum('adj.notes.category', n.category), 'neutral')} ` : ''}${n.visibility === 'shared_with_claimant' ? `${badge(t('adj.notes.shared'), 'info')} ` : ''}${esc(noteText(n))}<div class="adj-muted">${esc(personName(dir, n.author))} · ${esc(fmtWhen(n.createdAt))}</div></li>`).join('')}</ul>`
    : none('adj.notes.none');
  const form = `<form class="note-form fx-stack-sm" novalidate><label for="note-new">${esc(t('adj.notes.body'))}</label><textarea class="fx-textarea" id="note-new" name="body" rows="2" aria-describedby="note-err"></textarea>
<p class="err" id="note-err" role="alert" hidden></p>
<div><button class="fx-btn secondary small" type="submit">${esc(t('adj.notes.add'))}</button></div></form>`;
  return card('notes', t('adj.panel.notes'), `<div class="fx-stack-sm">${items}${form}</div>`);
}

/** Localised title for a timeline item from its type and params; unknown types keep the server label. */
export function timelineTitle(e, dir) {
  const p = e.params ?? {};
  const type = String(e.type ?? '');
  switch (type) {
    case 'claim.reported': return t('adj.tl.reported');
    case 'claim.acknowledged': return t('adj.tl.acknowledged');
    case 'claim.coverage.verified': return p.outcome ? t('adj.tl.coverage', { outcome: tEnum('adj.coverage.outcome', p.outcome) }) : t('adj.tl.coverage.plain');
    case 'claim.status.changed': if (p.to) return t('adj.tl.status', { from: formatEnum(p.from), to: formatEnum(p.to) }); break;
    case 'claim.routed': if (p.queue) {
      const who = p.adjusterName && p.adjusterName !== p.adjusterId ? p.adjusterName : p.adjusterId ? personName(dir, p.adjusterId) : '';
      return who ? t('adj.tl.routed.to', { queue: queueLabel(dir, p.queue), name: who }) : t('adj.tl.routed', { queue: queueLabel(dir, p.queue) });
    } break;
    case 'claim.triaged': if (p.severity !== undefined) return t('adj.tl.triaged', { severity: p.severity, fraud: p.fraud ?? '—' }); break;
    case 'claim.timer.due': return t('adj.tl.timer.due', { kind: tEnum('adj.timer.kind', p.kind) });
    case 'claim.timer.breached': return t('adj.tl.timer.breached', { kind: tEnum('adj.timer.kind', p.kind) });
    case 'claim.note.added': return t('adj.tl.note');
    case 'claim.evidence.added': return t('adj.tl.document');
    case 'claim.evidence.extracted': return t('adj.tl.extracted');
    case 'claim.routing.overridden': return t('adj.tl.override');
    case 'claim.task.updated': return t(p.status === 'cancelled' ? 'adj.tl.task.cancelled' : 'adj.tl.task.done');
    default: break;
  }
  return e.label && e.label !== type ? e.label.replace(/^Audit: (.+)$/, (_, a) => `Audit: ${formatEnum(a)}`) : formatEnum(type.replace(/^audit\./, 'audit '));
}

/** Audit timeline events for fx-timeline. AI events carry provider, model and confidence in `actor`. Pure. */
export function timelineEvents(view, dir) {
  return (view.timeline ?? []).filter((e) => e.at).map((e, i) => {
    const type = String(e.type ?? '');
    const tone = /breach|overdue/.test(type + e.label) ? 'danger' : /triage/.test(type) ? 'info' : /routed|routing|status/.test(type) ? 'brand' : /met|ack|task/.test(type) ? 'success' : 'neutral';
    const ai = /triage/.test(type) && hasProvenance(view.triage?.ai) ? t('adj.timeline.ai', { provider: view.triage.ai.provider, model: view.triage.ai.model, pct: pctOf(view.triage.ai) }) : undefined;
    return { at: e.at, title: timelineTitle(e, dir), tone, seq: i, ...(ai ? { actor: ai } : {}) };
  });
}

const TIMELINE_RECENT = 12;
export function timelinePanel(view, { dir } = {}) {
  const events = timelineEvents(view, dir);
  if (!events.length) return card('timeline', t('adj.panel.timeline'), none('adj.timeline.empty'));
  // Newest first; events published in the same millisecond keep their publication order (reversed).
  const sorted = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq).map(({ seq: _s, ...e }) => e);
  const recent = sorted.slice(0, TIMELINE_RECENT);
  const older = sorted.slice(TIMELINE_RECENT);
  const tl = (list) => `<fx-timeline data-events="${esc(JSON.stringify(list))}"></fx-timeline>`;
  const more = older.length ? `<details class="adj-older"><summary>${esc(t('adj.timeline.older', { count: older.length }))}</summary>${tl(older)}</details>` : '';
  return card('timeline', t('adj.panel.timeline'), tl(recent) + more);
}

/**
 * Header, subrogation banner and the two-column panel grid in display order.
 * @param {object} view AdjusterView
 * @param {{now?:number, done?:string[], dir?:object, role?:string}} [opts] dir: GET /adjuster/directory; role: adjuster | supervisor
 */
export function claimViewHtml(view, { now = Date.now(), done = [], dir = EMPTY_DIR, role = 'adjuster' } = {}) {
  const o = { dir, role };
  return `${headerHtml(view, now)}${subrogationBanner(view)}
<div class="fx-grid-main adj-grid">
<div class="fx-stack">${summaryPanel(view)}${nbaPanel(view, done)}${lossPanel(view)}${triagePanel(view, o)}${timelinePanel(view, o)}${notesPanel(view, o)}</div>
<div class="fx-stack">${actionsPanel(view, o)}${timersPanel(view, now)}${policyPanel(view)}${coveragePanel(view)}${partiesPanel(view)}${vehiclesPanel(view)}${documentsPanel(view)}${routingPanel(view, o)}${tasksPanel(view, o)}</div>
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
