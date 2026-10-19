import { t, getLocale } from '../i18n.js';
const HE = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

/** Sort events newest first (stable, tolerant of bad dates). Pure. */
export function sortEvents(events, order = 'desc') {
  const ts = (e) => { const n = Date.parse(e.at); return Number.isNaN(n) ? 0 : n; };
  return [...events].sort((a, b) => (order === 'asc' ? ts(a) - ts(b) : ts(b) - ts(a)));
}

/** Locale-aware date/time. Pure given locale. */
export function formatWhen(iso, locale = getLocale()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(d);
}

/**
 * <fx-timeline> with `.events=[{at,title,detail,actor,tone?}]`. Semantic ordered list with <time>.
 * Optional tone (info|success|warning|danger|brand|neutral) colours the event marker.
 */
export class FxTimeline extends HE {
  constructor() { super(); this._events = []; }
  connectedCallback() { this.render(); }
  get events() { return this._events; }
  set events(v) { this._events = Array.isArray(v) ? v : []; if (this.isConnected) this.render(); }
  render() {
    const doc = this.ownerDocument;
    this.textContent = '';
    if (!this._events.length) { const p = doc.createElement('p'); p.textContent = t('kit.timeline.empty'); this.appendChild(p); return; }
    const ol = doc.createElement('ol');
    ol.setAttribute('aria-label', t('kit.timeline.label'));
    for (const e of sortEvents(this._events, this.getAttribute('order') ?? 'desc')) {
      const li = doc.createElement('li');
      if (e.tone) li.dataset.tone = String(e.tone);
      const time = doc.createElement('time'); time.dateTime = e.at; time.textContent = formatWhen(e.at);
      const strong = doc.createElement('strong'); strong.textContent = e.title ?? '';
      li.append(time, doc.createElement('br'), strong);
      if (e.detail) { const p = doc.createElement('div'); p.textContent = e.detail; li.appendChild(p); }
      if (e.actor) { const a = doc.createElement('small'); a.textContent = e.actor; li.appendChild(a); }
      ol.appendChild(li);
    }
    this.appendChild(ol);
  }
}
