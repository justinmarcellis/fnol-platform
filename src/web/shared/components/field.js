import { t } from '../i18n.js';

const HE = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};
let uid = 0;

/**
 * Validate a value against rules. Pure.
 * @param {string} value
 * @param {{label?:string, required?:boolean, minLength?:number, maxLength?:number, pattern?:string}} rules
 * @returns {string|null} translated message or null
 */
export function validateField(value, rules = {}) {
  const label = rules.label ?? '';
  const v = value == null ? '' : String(value);
  if (rules.required && v.trim() === '') return t('kit.field.required', { label });
  if (v === '') return null;
  if (rules.minLength && v.length < rules.minLength) return t('kit.field.minLength', { label, min: rules.minLength });
  if (rules.maxLength && v.length > rules.maxLength) return t('kit.field.maxLength', { label, max: rules.maxLength });
  if (rules.pattern) {
    try { if (!new RegExp(rules.pattern).test(v)) return t('kit.field.invalid', { label }); } catch { /* bad pattern ignored */ }
  }
  return null;
}

/**
 * <fx-field label name type required hint value minlength maxlength pattern>
 * Optional options (select) via `.options = [{value,label}]`. Emits fx-change {name,value,valid}.
 */
export class FxField extends HE {
  static get observedAttributes() { return ['label', 'hint', 'error', 'value', 'required', 'type']; }
  constructor() { super(); this.options = []; this._id = `fxf${++uid}`; }
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  get value() { return this.querySelector('input,select,textarea')?.value ?? this.getAttribute('value') ?? ''; }
  set value(v) { this.setAttribute('value', v ?? ''); }
  rules() {
    return {
      label: this.getAttribute('label') ?? '',
      required: this.hasAttribute('required'),
      minLength: Number(this.getAttribute('minlength')) || 0,
      maxLength: Number(this.getAttribute('maxlength')) || 0,
      pattern: this.getAttribute('pattern') ?? '',
    };
  }
  validate() {
    const msg = this.getAttribute('error') || validateField(this.value, this.rules());
    this.setError(msg);
    return !msg;
  }
  setError(msg) {
    if (msg) { this.setAttribute('invalid', ''); this.setAttribute('error', msg); } else { this.removeAttribute('invalid'); this.removeAttribute('error'); }
  }
  render() {
    const id = this._id;
    const type = this.getAttribute('type') ?? 'text';
    const label = this.getAttribute('label') ?? '';
    const hint = this.getAttribute('hint');
    const error = this.getAttribute('error');
    const req = this.hasAttribute('required');
    const current = this.querySelector('input,select,textarea')?.value ?? this.getAttribute('value') ?? '';
    const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ');
    const doc = this.ownerDocument;
    this.textContent = '';
    const lab = doc.createElement('label');
    lab.setAttribute('for', id);
    lab.textContent = label + (req ? '' : ` (${t('common.optional')})`);
    let ctl;
    if (type === 'select') {
      ctl = doc.createElement('select');
      for (const o of this.options) { const op = doc.createElement('option'); op.value = o.value; op.textContent = o.label; ctl.appendChild(op); }
    } else if (type === 'textarea') ctl = doc.createElement('textarea');
    else { ctl = doc.createElement('input'); ctl.type = type; }
    ctl.id = id;
    ctl.name = this.getAttribute('name') ?? '';
    ctl.value = current;
    if (req) ctl.setAttribute('aria-required', 'true');
    if (error) ctl.setAttribute('aria-invalid', 'true');
    if (describedBy) ctl.setAttribute('aria-describedby', describedBy);
    const ac = this.getAttribute('autocomplete');
    if (ac) ctl.setAttribute('autocomplete', ac);
    ctl.addEventListener('input', () => this.dispatchEvent(new CustomEvent('fx-change', { bubbles: true, detail: { name: ctl.name, value: ctl.value, valid: !validateField(ctl.value, this.rules()) } })));
    ctl.addEventListener('blur', () => this.validate());
    this.append(lab, ctl);
    if (hint) { const h = doc.createElement('div'); h.id = `${id}-hint`; h.className = 'fx-hint'; h.textContent = hint; this.appendChild(h); }
    const e = doc.createElement('div');
    e.id = `${id}-err`; e.className = 'fx-error'; e.setAttribute('role', 'alert');
    if (error) e.textContent = error;
    this.appendChild(e);
  }
}
