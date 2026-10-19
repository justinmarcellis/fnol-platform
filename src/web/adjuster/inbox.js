// Inbox table columns and KPI tiles (browser DOM). Row view-models come from model.js.
import { t } from '../shared/i18n.js';
import { formatEnum, formatRelative, formatDateTime } from '../shared/format.js';
import { timerLabel } from './render.js';

const el = (doc, tag, attrs = {}, text) => {
  const n = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Timer cell: a badge coloured by urgency, kept live by app.js through data-due. */
export function timerBadge(row, doc = document, now = Date.now()) {
  const b = el(doc, 'fx-badge', { tone: row.timerTone, 'data-chip': 'timer', 'data-state': row.timerState });
  b.setAttribute('label', timerLabel(row.timer, now));
  if (row.timerState === 'overdue') b.setAttribute('variant', 'solid');
  if (['running', 'due_soon', 'overdue'].includes(row.timerState)) {
    b.dataset.due = row.timer.dueAt;
    b.dataset.kind = t(`adj.timer.kind.${row.timer.kind}`) === `adj.timer.kind.${row.timer.kind}` ? formatEnum(row.timer.kind) : t(`adj.timer.kind.${row.timer.kind}`);
  }
  return b;
}

/** Column definitions for fx-table. `now` is read at render time. */
export function inboxColumns(doc = document) {
  return [
    { key: 'claimNumber', label: t('adj.inbox.col.claim'), render: (r) => {
      return el(doc, 'a', { href: `#/claim/${encodeURIComponent(r.claimId)}`, class: 'adj-claim-link', 'data-claim-id': r.claimId, translate: 'no' }, r.claimNumber);
    } },
    { key: 'insured', label: t('adj.inbox.col.insured'), render: (r) => (r.insured ? r.insured : (() => el(doc, 'span', { class: 'adj-pending' }, '—'))()) },
    { key: 'lob', label: t('adj.inbox.col.line'), render: (r) => (r.lob ? formatEnum(r.lob) : '—') },
    { key: 'severityScore', label: t('adj.inbox.col.severity'), render: (r) => {
      if (!r.severityBand) return el(doc, 'fx-badge', { tone: 'neutral', label: t('adj.severity.unknown'), 'data-chip': 'severity' });
      const b = el(doc, 'fx-badge', { severity: r.severityBand, 'data-chip': 'severity' });
      b.setAttribute('label', `${formatEnum(r.severityBand)} · ${r.severityScore}`);
      return b;
    } },
    { key: 'status', label: t('adj.inbox.col.status'), render: (r) => el(doc, 'fx-badge', { status: r.status, kind: 'claim', 'data-chip': 'status' }) },
    { key: 'timerMs', label: t('adj.inbox.col.timer'), render: (r) => timerBadge(r, doc) },
    { key: 'assignedTs', label: t('adj.inbox.col.assigned'), numeric: true, render: (r) => {
      const s = el(doc, 'span', { title: r.assignedApprox ? t('adj.inbox.assigned.fallback', { at: formatDateTime(r.assignedAt) }) : formatDateTime(r.assignedAt) }, r.assignedAt ? formatRelative(r.assignedAt) : '—');
      return s;
    } },
  ];
}

/** KPI tile markup for the four inbox counts. Values are numbers; labels come from strings. */
export function renderKpis(container, kpis, doc = document) {
  container.textContent = '';
  const defs = [
    ['open', 'inbox', kpis.open], ['dueSoon', 'clock', kpis.dueSoon], ['overdue', 'alert-triangle', kpis.overdue], ['fastTracked', 'gauge', kpis.fastTracked],
  ];
  for (const [key, icon, value] of defs) {
    const s = el(doc, 'fx-stat', { label: t(`adj.kpi.${key}`), value: String(value), icon, hint: t(`adj.kpi.${key}.hint`), 'data-kpi': key });
    container.appendChild(s);
  }
}
