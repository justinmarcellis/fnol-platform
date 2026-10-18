import { t } from '../i18n.js';
const HE = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

/** State of each step for a current index. Pure. */
export function stepStates(count, current) {
  return Array.from({ length: count }, (_, i) => (i < current ? 'complete' : i === current ? 'current' : 'upcoming'));
}

/** Clamp navigation. Pure. */
export function goTo(count, index) { return Math.min(Math.max(0, index), Math.max(0, count - 1)); }

/**
 * <fx-stepper current="0"> with `.steps=[{id,label}]`. Renders an ordered list; current has aria-current="step".
 * Methods next()/back(); emits fx-change {current,id}.
 */
export class FxStepper extends HE {
  constructor() { super(); this.steps = []; }
  static get observedAttributes() { return ['current']; }
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  get current() { return goTo(this.steps.length, Number(this.getAttribute('current')) || 0); }
  set current(i) { this.setAttribute('current', String(goTo(this.steps.length, i))); this.dispatchEvent(new CustomEvent('fx-change', { bubbles: true, detail: { current: this.current, id: this.steps[this.current]?.id } })); }
  next() { this.current = this.current + 1; }
  back() { this.current = this.current - 1; }
  render() {
    const doc = this.ownerDocument;
    const cur = this.current;
    const states = stepStates(this.steps.length, cur);
    this.textContent = '';
    this.setAttribute('role', 'group');
    this.setAttribute('aria-label', t('kit.stepper.stepOf', { current: cur + 1, total: this.steps.length }));
    const ol = doc.createElement('ol');
    this.steps.forEach((s, i) => {
      const li = doc.createElement('li');
      li.dataset.state = states[i];
      if (states[i] === 'current') li.setAttribute('aria-current', 'step');
      const dot = doc.createElement('span');
      dot.className = 'fx-dot'; dot.setAttribute('aria-hidden', 'true');
      dot.textContent = states[i] === 'complete' ? '✓' : String(i + 1);
      const label = doc.createElement('span');
      label.textContent = s.label;
      li.append(dot, label);
      if (states[i] !== 'upcoming') {
        const sr = doc.createElement('span');
        sr.className = 'fx-visually-hidden';
        sr.textContent = ` (${states[i] === 'complete' ? t('kit.stepper.complete') : t('kit.stepper.current')})`;
        li.appendChild(sr);
      }
      ol.appendChild(li);
    });
    this.appendChild(ol);
    const live = doc.createElement('div');
    live.className = 'fx-visually-hidden'; live.setAttribute('aria-live', 'polite');
    live.textContent = t('kit.stepper.stepOf', { current: cur + 1, total: this.steps.length });
    this.appendChild(live);
  }
}
