const HE = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

/** Toggle `value` in a selection. Single mode replaces; multi toggles. Pure. */
export function toggleSelection(selected, value, multiple) {
  if (!multiple) return [value];
  return selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
}

/** Next focus index for arrow/Home/End keys (wraps). Returns null for other keys. Pure. */
export function nextIndex(index, key, count) {
  if (!count) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * <fx-chips label multiple> with `.options=[{value,label}]` and `.value` (array of values).
 * Single = radiogroup, multiple = checkbox group. Roving tabindex, arrow keys, Space/Enter select.
 * Emits fx-change {value:[...]}.
 */
export class FxChips extends HE {
  constructor() { super(); this.options = []; this._sel = []; }
  connectedCallback() { this.render(); }
  get value() { return [...this._sel]; }
  set value(v) { this._sel = Array.isArray(v) ? [...v] : v ? [v] : []; if (this.isConnected) this.render(); }
  set choices(o) { this.options = o; if (this.isConnected) this.render(); }
  render(focusIdx) {
    const multi = this.hasAttribute('multiple');
    const doc = this.ownerDocument;
    this.textContent = '';
    const group = doc.createElement('div');
    group.setAttribute('role', multi ? 'group' : 'radiogroup');
    if (this.getAttribute('label')) group.setAttribute('aria-label', this.getAttribute('label'));
    const role = multi ? 'checkbox' : 'radio';
    const firstSel = Math.max(0, this.options.findIndex((o) => this._sel.includes(o.value)));
    this.options.forEach((o, i) => {
      const chip = doc.createElement('span');
      const on = this._sel.includes(o.value);
      chip.setAttribute('role', role);
      chip.setAttribute('aria-checked', String(on));
      chip.tabIndex = multi || i === firstSel ? 0 : -1;
      chip.dataset.value = o.value;
      chip.textContent = o.label;
      const pick = () => {
        this._sel = toggleSelection(this._sel, o.value, multi);
        this.render(i);
        this.dispatchEvent(new CustomEvent('fx-change', { bubbles: true, detail: { value: this.value } }));
      };
      chip.addEventListener('click', pick);
      chip.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pick(); return; }
        const n = nextIndex(i, e.key, this.options.length);
        if (n !== null) { e.preventDefault(); this.querySelectorAll(`[role=${role}]`)[n].focus(); }
      });
      group.appendChild(chip);
    });
    this.appendChild(group);
    if (focusIdx !== undefined) this.querySelectorAll(`[role=${role}]`)[focusIdx]?.focus();
  }
}
