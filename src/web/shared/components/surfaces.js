// Light-DOM layout components: fx-card, fx-empty-state, fx-skeleton, fx-stat.
// No shadow DOM, so app CSS and tests can reach inside; named children use a `slot` attribute.
import { createIcon } from '../icons.js';
import { kt } from './kit-strings.js';
const HE = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

/**
 * Group an element's current children by their `slot` attribute (default = ''). Pure over a children list.
 * @param {ArrayLike<{getAttribute:(n:string)=>string|null}>} children
 * @returns {Record<string, any[]>}
 */
export function groupSlots(children) {
  const out = {};
  for (const c of Array.from(children ?? [])) {
    const name = (c.getAttribute ? c.getAttribute('slot') : null) ?? '';
    (out[name] ??= []).push(c);
  }
  return out;
}

const headingLevel = (v, dflt) => { const n = Number(v); return n >= 1 && n <= 6 ? n : dflt; };

/**
 * <fx-card heading="Recent claims" subheading="Last 24 hours" level="2" padding="none|sm|md">
 *   <button slot="actions">…</button> body… <div slot="footer">…</div>
 * </fx-card>
 * Without heading it is a plain bordered surface.
 */
export class FxCard extends HE {
  static get observedAttributes() { return ['heading', 'subheading']; }
  connectedCallback() { if (!this._built) this.build(); }
  attributeChangedCallback() { if (this._built) this.updateHeader(); }
  build() {
    const doc = this.ownerDocument;
    const slots = groupSlots(this.childNodes.length ? [...this.children] : []);
    const loose = [...this.childNodes].filter((n) => n.nodeType !== 1 || !n.getAttribute('slot'));
    this._built = true;
    this._header = doc.createElement('div'); this._header.className = 'fx-card-header';
    this._titles = doc.createElement('div'); this._titles.className = 'fx-card-titles';
    const actions = doc.createElement('div'); actions.className = 'fx-card-actions';
    for (const a of slots.actions ?? []) actions.appendChild(a);
    this._header.append(this._titles, actions);
    this._body = doc.createElement('div'); this._body.className = 'fx-card-body';
    for (const n of loose) this._body.appendChild(n);
    this.textContent = '';
    this.append(this._header, this._body);
    if (slots.footer?.length) {
      const f = doc.createElement('div'); f.className = 'fx-card-footer';
      for (const n of slots.footer) f.appendChild(n);
      this.appendChild(f);
    }
    this.updateHeader();
  }
  updateHeader() {
    const doc = this.ownerDocument;
    const heading = this.getAttribute('heading');
    const sub = this.getAttribute('subheading');
    this._titles.textContent = '';
    if (heading) {
      const h = doc.createElement(`h${headingLevel(this.getAttribute('level'), 2)}`);
      h.className = 'fx-card-title'; h.textContent = heading;
      if (this.id) h.id = `${this.id}-title`;
      this._titles.appendChild(h);
    }
    if (sub) { const p = doc.createElement('p'); p.className = 'fx-card-subtitle'; p.textContent = sub; this._titles.appendChild(p); }
    const hasActions = this._header.querySelector('.fx-card-actions').children.length > 0;
    this._header.hidden = !heading && !sub && !hasActions;
  }
}

/**
 * <fx-empty-state icon="inbox" heading="No claims yet" description="New claims appear here.">
 *   <button class="fx-btn">Start a claim</button>
 * </fx-empty-state>
 */
export class FxEmptyState extends HE {
  connectedCallback() { if (!this._built) this.build(); }
  build() {
    const doc = this.ownerDocument;
    this._built = true;
    const actions = [...this.childNodes];
    this.textContent = '';
    const art = doc.createElement('div'); art.className = 'fx-empty-icon';
    const ic = createIcon(this.getAttribute('icon') ?? 'inbox', { size: 24, doc });
    if (ic) art.appendChild(ic);
    const h = doc.createElement(`h${headingLevel(this.getAttribute('level'), 3)}`); h.className = 'fx-empty-title'; h.textContent = this.getAttribute('heading') ?? '';
    this.append(art, h);
    if (this.getAttribute('description')) { const p = doc.createElement('p'); p.className = 'fx-empty-text'; p.textContent = this.getAttribute('description'); this.appendChild(p); }
    if (actions.some((n) => n.nodeType === 1 || n.textContent.trim())) {
      const a = doc.createElement('div'); a.className = 'fx-empty-actions';
      for (const n of actions) a.appendChild(n);
      this.appendChild(a);
    }
  }
}

/** Widths for skeleton text lines: varied so it reads as text, last line short. Pure. */
export function skeletonWidths(lines) {
  const n = Math.max(1, Math.min(20, Number(lines) || 3));
  const pattern = [100, 92, 96, 88, 94];
  return Array.from({ length: n }, (_, i) => (i === n - 1 && n > 1 ? 60 : pattern[i % pattern.length]));
}

/**
 * <fx-skeleton variant="text|block|circle|table|card" lines="3" rows="5" label="Loading claims">
 * Placeholder shimmer while data loads; announces once via role=status. Respects reduced motion.
 */
export class FxSkeleton extends HE {
  static get observedAttributes() { return ['variant', 'lines', 'rows', 'label']; }
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const doc = this.ownerDocument;
    const variant = this.getAttribute('variant') ?? 'text';
    this.textContent = '';
    this.setAttribute('role', 'status');
    this.setAttribute('aria-busy', 'true');
    const sr = doc.createElement('span'); sr.className = 'fx-visually-hidden'; sr.textContent = this.getAttribute('label') ?? kt('skeleton.loading');
    this.appendChild(sr);
    const bone = (cls, w) => { const b = doc.createElement('span'); b.className = `fx-bone ${cls}`; b.setAttribute('aria-hidden', 'true'); if (w) b.style.width = `${w}%`; return b; };
    if (variant === 'circle' || variant === 'block') { this.appendChild(bone(`fx-bone-${variant}`)); return; }
    if (variant === 'table') {
      const rows = Math.max(1, Math.min(30, Number(this.getAttribute('rows')) || 5));
      const head = doc.createElement('div'); head.className = 'fx-skel-row fx-skel-head';
      for (const w of [18, 14, 22, 16]) head.appendChild(bone('fx-bone-text', w));
      this.appendChild(head);
      for (let r = 0; r < rows; r++) {
        const row = doc.createElement('div'); row.className = 'fx-skel-row';
        for (const w of [22, 12, 26, 14]) row.appendChild(bone('fx-bone-text', w - (r % 3) * 2));
        this.appendChild(row);
      }
      return;
    }
    if (variant === 'card') {
      const top = doc.createElement('div'); top.className = 'fx-skel-media';
      top.append(bone('fx-bone-circle'));
      const lines = doc.createElement('div'); lines.className = 'fx-skel-lines';
      lines.append(bone('fx-bone-text fx-bone-strong', 45), bone('fx-bone-text', 30));
      top.appendChild(lines);
      this.appendChild(top);
    }
    for (const w of skeletonWidths(this.getAttribute('lines'))) this.appendChild(bone('fx-bone-text', w));
  }
}

/** Direction of a delta string or number: 'up' | 'down' | 'flat'. Pure. */
export function trendOf(delta) {
  if (delta === null || delta === undefined || delta === '') return 'flat';
  const n = typeof delta === 'number' ? delta : Number(String(delta).replace(/[^\d.+-]/g, ''));
  if (!Number.isFinite(n) || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}

/**
 * Tone of a trend given which direction is good ('up' default, 'down' for e.g. cycle time). Pure.
 * @returns {'success'|'danger'|'neutral'}
 */
export function trendTone(trend, good = 'up') {
  if (trend === 'flat') return 'neutral';
  return trend === good ? 'success' : 'danger';
}

/**
 * <fx-stat label="Open claims" value="128" delta="+12%" good="up|down" period="last week" icon="inbox" hint="…">
 * KPI tile. The delta is coloured by whether its direction is good, and spoken in words for screen readers.
 */
export class FxStat extends HE {
  static get observedAttributes() { return ['label', 'value', 'delta', 'good', 'period', 'icon', 'hint', 'trend']; }
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const doc = this.ownerDocument;
    this.textContent = '';
    const head = doc.createElement('div'); head.className = 'fx-stat-head';
    const label = doc.createElement('span'); label.className = 'fx-stat-label'; label.textContent = this.getAttribute('label') ?? '';
    head.appendChild(label);
    if (this.getAttribute('icon')) {
      const ic = doc.createElement('span'); ic.className = 'fx-stat-icon';
      const svg = createIcon(this.getAttribute('icon'), { size: 18, doc }); if (svg) ic.appendChild(svg);
      head.appendChild(ic);
    }
    const value = doc.createElement('div'); value.className = 'fx-stat-value'; value.textContent = this.getAttribute('value') ?? '—';
    this.append(head, value);
    const delta = this.getAttribute('delta');
    if (delta) {
      const trend = this.getAttribute('trend') ?? trendOf(delta);
      const tone = trendTone(trend, this.getAttribute('good') ?? 'up');
      const d = doc.createElement('div'); d.className = 'fx-stat-delta'; d.dataset.tone = tone; d.dataset.trend = trend;
      const svg = createIcon(trend === 'up' ? 'trend-up' : trend === 'down' ? 'trend-down' : 'minus', { size: 16, doc });
      if (svg) d.appendChild(svg);
      const v = doc.createElement('span'); v.className = 'fx-stat-delta-value'; v.textContent = delta;
      const sr = doc.createElement('span'); sr.className = 'fx-visually-hidden'; sr.textContent = ` (${kt(`stat.${trend}`)})`;
      d.append(v, sr);
      if (this.getAttribute('period')) { const p = doc.createElement('span'); p.className = 'fx-stat-period'; p.textContent = kt('stat.vs', { period: this.getAttribute('period') }); d.appendChild(p); }
      this.appendChild(d);
    }
    if (this.getAttribute('hint')) { const h = doc.createElement('div'); h.className = 'fx-stat-hint'; h.textContent = this.getAttribute('hint'); this.appendChild(h); }
  }
}
