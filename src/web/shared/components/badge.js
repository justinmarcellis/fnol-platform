import { formatEnum } from '../format.js';
const HE = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

/** Semantic tones available to badges. */
export const TONES = ['neutral', 'info', 'success', 'warning', 'danger', 'brand'];

/**
 * Status vocabularies -> semantic tone. Labels come from format.js (en/es).
 * claim: Claim.status; severity: TriageResult.severityBand; task: Task.status; sync: core sync; coverage: CoverageVerification.
 */
export const STATUS_TONES = {
  claim: {
    reported: 'info', validating: 'info', triaged: 'brand', assigned: 'brand', fast_tracked: 'success',
    in_review: 'warning', pending_info: 'warning', closed: 'neutral', withdrawn: 'neutral',
  },
  severity: { minor: 'success', moderate: 'info', major: 'warning', severe: 'danger' },
  task: { open: 'info', in_progress: 'brand', done: 'success', cancelled: 'neutral' },
  sync: { pending: 'warning', synced: 'success', failed: 'danger' },
  coverage: { pending: 'neutral', covered: 'success', partial: 'warning', not_covered: 'danger', needs_review: 'warning' },
  risk: { low: 'success', medium: 'warning', high: 'danger' },
};

/**
 * Human label and tone for a status value. Pure.
 * @param {string} value e.g. 'pending_info', 'severe'
 * @param {string} [kind] vocabulary in STATUS_TONES; when omitted the first vocabulary containing the value wins
 * @param {{locale?:string}} [opts]
 * @returns {{value:string, label:string, tone:string, kind:string|null}}
 */
export function statusMeta(value, kind, { locale } = {}) {
  const v = String(value ?? '');
  let k = kind && STATUS_TONES[kind] ? kind : null;
  if (!k) k = Object.keys(STATUS_TONES).find((name) => v in STATUS_TONES[name]) ?? null;
  const tone = (k && STATUS_TONES[k][v]) || 'neutral';
  return { value: v, label: formatEnum(v, { locale }), tone, kind: k };
}

/**
 * <fx-badge status="pending_info" kind="claim"> / <fx-badge severity="major"> / <fx-badge tone="success">Text</fx-badge>
 * Status chip with a coloured dot and human label. `variant="solid"` for emphasis, `dot="false"` to hide the dot.
 * Text content, when present and no status/severity is set, is used as the label.
 */
export class FxBadge extends HE {
  static get observedAttributes() { return ['status', 'severity', 'kind', 'tone', 'label']; }
  // Upgrades call attributeChangedCallback before connectedCallback, so capture slotted text in render.
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    if (this._text === undefined) this._text = this.textContent.trim();
    const doc = this.ownerDocument;
    const sev = this.getAttribute('severity');
    const status = sev ?? this.getAttribute('status');
    const meta = status ? statusMeta(status, sev ? 'severity' : this.getAttribute('kind') ?? undefined) : null;
    const tone = this.getAttribute('tone') ?? meta?.tone ?? 'neutral';
    const label = this.getAttribute('label') ?? meta?.label ?? this._text ?? '';
    this.dataset.tone = TONES.includes(tone) ? tone : 'neutral';
    if (meta) this.dataset.value = meta.value;
    this.textContent = '';
    if (this.getAttribute('dot') !== 'false') {
      const dot = doc.createElement('span'); dot.className = 'fx-badge-dot'; dot.setAttribute('aria-hidden', 'true');
      this.appendChild(dot);
    }
    const text = doc.createElement('span'); text.className = 'fx-badge-label'; text.textContent = label;
    this.appendChild(text);
  }
}

/** Build a badge element imperatively (for table cells). Returns null without a DOM. */
export function createBadge(value, kind, doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return null;
  const b = doc.createElement('fx-badge');
  if (kind === 'severity') b.setAttribute('severity', value); else { b.setAttribute('status', value); if (kind) b.setAttribute('kind', kind); }
  return b;
}
