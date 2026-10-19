import { t } from '../i18n.js';
import { createIcon } from '../icons.js';

const TOAST_ICON = { success: 'check-circle', error: 'x-circle', warning: 'alert-triangle', info: 'info' };
const HE = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

/** Toast queue logic. Pure. Keeps at most `limit` items (oldest dropped). */
export function pushToast(list, toast, limit = 4) {
  const item = { id: toast.id ?? `t${list.length}${Date.now().toString(36)}`, kind: toast.kind ?? 'info', message: String(toast.message ?? ''), timeout: toast.timeout ?? (toast.kind === 'error' ? 0 : 6000) };
  return [...list, item].slice(-limit);
}
export function dismissToast(list, id) { return list.filter((x) => x.id !== id); }

/**
 * <fx-toast>: show(message, {kind, timeout}) -> id. Errors and alerts use role=alert; others role=status.
 * Timeout 0 = stays until dismissed. Mount once near the app root.
 */
export class FxToast extends HE {
  constructor() { super(); this.items = []; this._timers = new Map(); }
  connectedCallback() { this.render(); }
  disconnectedCallback() { for (const h of this._timers.values()) clearTimeout(h); this._timers.clear(); }
  show(message, opts = {}) {
    this.items = pushToast(this.items, { ...opts, message });
    const item = this.items[this.items.length - 1];
    if (item.timeout > 0) this._timers.set(item.id, setTimeout(() => this.dismiss(item.id), item.timeout));
    this.render();
    return item.id;
  }
  dismiss(id) {
    clearTimeout(this._timers.get(id)); this._timers.delete(id);
    this.items = dismissToast(this.items, id);
    this.render();
  }
  render() {
    const doc = this.ownerDocument;
    this.textContent = '';
    for (const it of this.items) {
      const d = doc.createElement('div');
      d.className = 'fx-toast-item'; d.dataset.kind = it.kind;
      d.setAttribute('role', it.kind === 'error' || it.kind === 'warning' ? 'alert' : 'status');
      const ic = createIcon(TOAST_ICON[it.kind] ?? 'info', { size: 20, doc, className: 'fx-icon fx-toast-icon' });
      const m = doc.createElement('span'); m.className = 'fx-toast-msg'; m.textContent = it.message;
      const b = doc.createElement('button');
      b.type = 'button'; b.className = 'fx-toast-close'; b.setAttribute('aria-label', t('kit.toast.dismiss'));
      const x = createIcon('x', { size: 16, doc });
      if (x) b.appendChild(x); else b.textContent = '×';
      b.addEventListener('click', () => this.dismiss(it.id));
      if (ic) d.appendChild(ic);
      d.append(m, b);
      this.appendChild(d);
    }
  }
}
