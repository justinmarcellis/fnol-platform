// <fx-demo-bar>: demo-only tenant and persona switcher. Renders nothing unless window.__FNOL_DEV__ === true.
// Light DOM. Place it as <fx-demo-bar slot="demo"> inside <fx-app-shell>, or at the top of any page.
// Never imported by app-shell.js. Styles are injected once and use the --fx-demo-* tokens with fallbacks.
import { createApiClient } from '../api.js';
import { groupPersonas, loadPersonas, readSession, switchPersona, ROLE_LABELS } from '../personas.js';

const HE = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};
const STYLE_ID = 'fx-demo-bar-style';

const CSS = `
fx-demo-bar { display: block; font-family: var(--fx-font, system-ui, sans-serif); font-size: .875rem; }
fx-demo-bar[hidden] { display: none; }
fx-demo-bar .fxd { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; box-sizing: border-box; min-height: 44px; padding: 6px 16px;
  background: var(--fx-demo-bg, #111a24); color: var(--fx-demo-fg, #eef2f6); border-bottom: 1px solid var(--fx-demo-border, #33465a); }
fx-demo-bar .fxd-pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; font-weight: 700; letter-spacing: .06em;
  text-transform: uppercase; font-size: .6875rem; background: #f0b25a; color: #1b1300; }
fx-demo-bar .fxd-pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #1b1300; }
fx-demo-bar .fxd-field { display: inline-flex; align-items: center; gap: 8px; margin: 0; }
fx-demo-bar .fxd-field > span { color: var(--fx-demo-muted, #b4c0cd); font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; }
fx-demo-bar select { font: inherit; color: inherit; background: #1b2735; border: 1px solid #4a5f75; border-radius: 6px; min-height: 32px; padding: 3px 28px 3px 10px; max-width: 300px; cursor: pointer; }
fx-demo-bar select:hover { border-color: #7d8da0; }
fx-demo-bar select:disabled { opacity: .6; cursor: progress; }
fx-demo-bar :focus-visible { outline: 3px solid #7db8f5; outline-offset: 2px; }
fx-demo-bar .fxd-who { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; min-width: 0; }
fx-demo-bar .fxd-avatar { width: 28px; height: 28px; border-radius: 50%; display: inline-grid; place-items: center; font-weight: 700; font-size: .75rem; background: #7db8f5; color: #0b1a2a; flex: none; }
fx-demo-bar .fxd-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
fx-demo-bar .fxd-role { padding: 1px 8px; border-radius: 999px; border: 1px solid #4a5f75; font-size: .75rem; color: var(--fx-demo-muted, #b4c0cd); white-space: nowrap; }
fx-demo-bar .fxd-status { color: #f0b25a; min-height: 1em; }
fx-demo-bar .fxd-status[data-kind='error'] { color: #ff8a9b; }
fx-demo-bar .fxd-toggle { display: none; font: inherit; color: inherit; background: transparent; border: 1px solid #4a5f75; border-radius: 6px; min-height: 32px; padding: 3px 10px; cursor: pointer; }
fx-demo-bar .fxd-panel { display: contents; }
@media (max-width: 719px) {
  fx-demo-bar .fxd-toggle { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
  fx-demo-bar .fxd-panel { display: none; flex-basis: 100%; flex-direction: column; align-items: stretch; gap: 8px; padding-bottom: 6px; }
  fx-demo-bar[data-open] .fxd-panel { display: flex; }
  fx-demo-bar .fxd-field { justify-content: space-between; }
  fx-demo-bar select { flex: 1; max-width: none; }
  fx-demo-bar .fxd-who { margin-left: 0; }
}`;

function initials(name) {
  return String(name ?? '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
}

/** True when the runtime config says this server has dev login. */
export function demoBarEnabled(env = globalThis) {
  return env.__FNOL_DEV__ === true;
}

export class FxDemoBar extends HE {
  constructor() {
    super();
    this.tenants = [];
    this.tenantId = null;
    this.current = null; // {persona, tenantId}
    this.busy = false;
    /** Overridable for tests and hosts. */
    this.navigate = (url) => globalThis.location.assign(url);
    this.api = null;
  }

  connectedCallback() {
    if (!demoBarEnabled()) { this.hidden = true; this.textContent = ''; return; }
    this.hidden = false;
    this._injectStyle();
    this.api ??= createApiClient({ baseUrl: this.getAttribute('base-url') ?? '/api/v1' });
    this._onKey = (e) => { if (e.key === 'Escape' && this.hasAttribute('data-open')) { this._setOpen(false); this.querySelector('.fxd-toggle')?.focus(); } };
    this.addEventListener('keydown', this._onKey);
    this.render();
    this.load();
  }

  disconnectedCallback() { if (this._onKey) this.removeEventListener('keydown', this._onKey); }

  _injectStyle() {
    const doc = this.ownerDocument;
    if (doc.getElementById(STYLE_ID)) return;
    const st = doc.createElement('style');
    st.id = STYLE_ID; st.textContent = CSS;
    doc.head.appendChild(st);
  }

  _setOpen(open) {
    this.toggleAttribute('data-open', open);
    this.querySelector('.fxd-toggle')?.setAttribute('aria-expanded', String(open));
  }

  async load() {
    try {
      const { tenants } = await loadPersonas(this.api);
      this.tenants = tenants;
      const s = readSession();
      const fromUrl = new URLSearchParams(globalThis.location?.search ?? '').get('tenant');
      this.current = s ? { persona: s.persona, tenantId: s.tenantId } : null;
      this.tenantId = [s?.tenantId, fromUrl, tenants[0]?.id].find((id) => tenants.some((t) => t.id === id)) ?? null;
      this.status('');
    } catch (e) {
      this.status('Demo personas unavailable', 'error');
    }
    this.render();
  }

  status(msg, kind = 'info') {
    this._msg = msg; this._kind = kind;
    const el = this.querySelector('.fxd-status');
    if (el) { el.textContent = msg; el.dataset.kind = kind; }
  }

  async choose(tenantId, persona) {
    if (this.busy) return;
    this.busy = true; this.render();
    this.status(`Signing in as ${persona.displayName}...`);
    try {
      const { url } = await switchPersona(this.api, { tenantId, persona });
      this.current = { persona, tenantId };
      this.dispatchEvent(new CustomEvent('fx-persona-switch', { bubbles: true, detail: { tenantId, persona, url } }));
      this.navigate(url);
    } catch (e) {
      this.status(`Could not switch persona: ${e.message}`, 'error');
    } finally {
      this.busy = false; this.render();
    }
  }

  _onTenant(id) {
    this.tenantId = id;
    const t = this.tenants.find((x) => x.id === id);
    const role = this.current?.persona?.role;
    const same = t?.personas.find((p) => p.role === role) ?? null;
    if (same) this.choose(id, same); else this.render();
  }

  _onPersona(pid) {
    const t = this.tenants.find((x) => x.id === this.tenantId);
    const p = t?.personas.find((x) => x.id === pid);
    if (p) this.choose(t.id, p);
  }

  render() {
    if (!demoBarEnabled()) return;
    const doc = this.ownerDocument;
    const h = (tag, attrs = {}, ...kids) => {
      const el = doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) { if (v === true) el.setAttribute(k, ''); else if (v !== false && v != null) el.setAttribute(k, v); }
      el.append(...kids.flat().filter((k) => k != null));
      return el;
    };
    const hadFocus = this.contains(doc.activeElement) ? doc.activeElement.id : null;
    const t = this.tenants.find((x) => x.id === this.tenantId);
    const cur = this.current && this.current.tenantId === this.tenantId ? this.current.persona : null;

    const tenantSel = h('select', { id: 'fxd-tenant', disabled: this.busy || !this.tenants.length },
      ...(this.tenants.length ? this.tenants.map((x) => h('option', { value: x.id, selected: x.id === this.tenantId }, x.name)) : [h('option', {}, 'Loading...')]));
    tenantSel.addEventListener('change', () => this._onTenant(tenantSel.value));

    const personaSel = h('select', { id: 'fxd-persona', disabled: this.busy || !t },
      !cur ? h('option', { value: '', selected: true, disabled: true }, 'Choose a persona...') : null,
      ...groupPersonas(t?.personas ?? []).map((g) => h('optgroup', { label: g.label },
        ...g.personas.map((p) => h('option', { value: p.id, selected: cur?.id === p.id }, `${p.displayName} (${ROLE_LABELS[p.role] ?? p.role})`)))));
    personaSel.addEventListener('change', () => personaSel.value && this._onPersona(personaSel.value));

    const who = cur
      ? h('span', { class: 'fxd-who' }, h('span', { class: 'fxd-avatar', 'aria-hidden': 'true' }, initials(cur.displayName)),
        h('span', { class: 'fxd-name' }, cur.displayName), h('span', { class: 'fxd-role' }, ROLE_LABELS[cur.role] ?? cur.role))
      : h('span', { class: 'fxd-who fxd-role' }, 'Not signed in');

    const open = this.hasAttribute('data-open');
    const toggle = h('button', { class: 'fxd-toggle', type: 'button', 'aria-expanded': String(open), 'aria-controls': 'fxd-panel' }, 'Switch');
    toggle.addEventListener('click', () => this._setOpen(!this.hasAttribute('data-open')));

    const bar = h('div', { class: 'fxd', role: 'region', 'aria-label': 'Demo controls' },
      h('span', { class: 'fxd-pill' }, 'Demo'),
      toggle,
      h('div', { class: 'fxd-panel', id: 'fxd-panel' },
        h('label', { class: 'fxd-field', for: 'fxd-tenant' }, h('span', {}, 'Tenant'), tenantSel),
        h('label', { class: 'fxd-field', for: 'fxd-persona' }, h('span', {}, 'Persona'), personaSel),
        who,
        h('span', { class: 'fxd-status', role: 'status', 'aria-live': 'polite', 'data-kind': this._kind ?? 'info' }, this._msg ?? '')));
    this.replaceChildren(bar);
    if (hadFocus) this.querySelector(`#${hadFocus}`)?.focus();
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('fx-demo-bar')) customElements.define('fx-demo-bar', FxDemoBar);
