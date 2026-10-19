// <fx-app-shell>: product chrome shared by every app (light DOM, zero dependencies).
import { createIcon } from '../icons.js';
import { initials } from '../format.js';
import { kt } from './kit-strings.js';
const HE = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};
let uid = 0;

/** Slot names the shell distributes; anything else goes to the page content. */
export const SHELL_SLOTS = ['demo', 'nav', 'actions', 'user-menu'];

/** Human role label: 'tenant_admin' -> 'Tenant admin', 'csr' -> 'CSR'. Pure. */
export function roleLabel(role) {
  const r = String(role ?? '').trim();
  if (!r) return '';
  const known = { csr: 'CSR', siu: 'SIU', api: 'API' };
  if (known[r.toLowerCase()]) return known[r.toLowerCase()];
  const words = r.replace(/[_-]+/g, ' ').split(/\s+/);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(' ');
}

/** Next menu item index for a key (wraps), or null. Pure. */
export function menuIndex(index, key, count) {
  if (!count) return null;
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * <fx-app-shell product="Claims Desk" tenant-name="Aurelia Mutual (fictional)" heading="Inbox" subheading="…"
 *               user-name="Dana Whitfield" user-role="adjuster" nav-label="Primary" home-href="/adjuster">
 *   <fx-demo-bar slot="demo"></fx-demo-bar>          sticky band above the top bar (S6-EXP-02 persona switcher)
 *   <a slot="nav" href="#/" aria-current="page">Inbox</a>
 *   <button slot="actions" class="fx-btn">New claim</button>   page header actions
 *   <button slot="user-menu">Preferences</button>     extra account-menu items
 *   …page content (default slot)…
 * </fx-app-shell>
 * Sets --fx-demo-height (on itself and :root) to the demo band height. Emits fx-signout from the account menu.
 * `.navItems = [{href,label,icon?,current?}]` renders nav links. Collapses nav into a menu button below 768 px.
 */
/** Shared product icon for every app page, so browsers do not fall back to a missing /favicon.ico (DATA-17). */
export const FAVICON_HREF = '/shared/favicon.svg';
export function ensureFavicon(doc) {
  if (!doc?.head || doc.head.querySelector('link[rel~="icon"]')) return;
  const link = doc.createElement('link');
  link.rel = 'icon'; link.type = 'image/svg+xml'; link.href = FAVICON_HREF;
  doc.head.appendChild(link);
}

export class FxAppShell extends HE {
  static get observedAttributes() { return ['product', 'tenant-name', 'heading', 'subheading', 'user-name', 'user-role', 'nav-label', 'home-href', 'logo']; }
  constructor() { super(); this._id = `fxshell${++uid}`; this._onDoc = (e) => this.onDocument(e); }
  connectedCallback() {
    ensureFavicon(this.ownerDocument);
    if (!this._built) this.build();
    this.ownerDocument.addEventListener('click', this._onDoc);
    this.ownerDocument.addEventListener('keydown', this._onDoc);
  }
  disconnectedCallback() {
    this.ownerDocument.removeEventListener('click', this._onDoc);
    this.ownerDocument.removeEventListener('keydown', this._onDoc);
    this._mo?.disconnect(); this._ro?.disconnect(); this._mq?.removeEventListener?.('change', this._onMq);
  }
  attributeChangedCallback() { if (this._built) this.update(); }

  get navItems() { return this._navItems ?? []; }
  set navItems(items) {
    this._navItems = Array.isArray(items) ? items : [];
    if (!this._built) return;
    const doc = this.ownerDocument;
    for (const a of [...this._nav.querySelectorAll('[data-generated]')]) a.remove();
    for (const it of this._navItems) {
      const a = doc.createElement('a'); a.href = it.href ?? '#'; a.dataset.generated = '';
      if (it.current) a.setAttribute('aria-current', 'page');
      if (it.icon) { const ic = createIcon(it.icon, { size: 18, doc }); if (ic) a.appendChild(ic); }
      const s = doc.createElement('span'); s.textContent = it.label ?? ''; a.appendChild(s);
      this._nav.appendChild(a);
    }
    this.syncRegions();
  }

  build() {
    const doc = this.ownerDocument;
    this._built = true;
    const existing = [...this.childNodes];
    this.textContent = '';
    const el = (tag, cls, attrs = {}) => { const n = doc.createElement(tag); if (cls) n.className = cls; for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

    this._sticky = el('div', 'fx-shell-sticky');
    this._demo = el('div', 'fx-shell-demo', { role: 'region', 'aria-label': kt('shell.demo') });
    const top = el('header', 'fx-shell-top');
    const inner = el('div', 'fx-shell-top-inner');
    this._toggle = el('button', 'fx-shell-navtoggle fx-btn ghost icon', { type: 'button', 'aria-expanded': 'false', 'aria-controls': `${this._id}-nav`, 'aria-label': kt('shell.openNav') });
    this._toggle.appendChild(createIcon('menu', { size: 20, doc }));
    this._toggle.addEventListener('click', () => this.setNavOpen(this._toggle.getAttribute('aria-expanded') !== 'true'));
    this._brand = el('a', 'fx-shell-brand');
    this._mark = el('span', 'fx-shell-mark', { 'aria-hidden': 'true' });
    this._brandText = el('span', 'fx-shell-brandtext');
    this._product = el('span', 'fx-shell-product');
    this._tenant = el('span', 'fx-shell-tenant');
    this._brandText.append(this._product, this._tenant);
    this._brand.append(this._mark, this._brandText);
    this._nav = el('nav', 'fx-shell-nav', { id: `${this._id}-nav` });
    this._nav.addEventListener('click', (e) => { if (e.target.closest?.('a')) this.setNavOpen(false); });
    const spacer = el('div', 'fx-shell-spacer');
    this._user = el('div', 'fx-shell-user');
    this._userBtn = el('button', 'fx-shell-userbtn', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': `${this._id}-menu` });
    this._avatar = el('span', 'fx-avatar', { 'aria-hidden': 'true' });
    const who = el('span', 'fx-shell-who');
    this._userName = el('span', 'fx-shell-username');
    this._userRole = el('span', 'fx-shell-userrole');
    who.append(this._userName, this._userRole);
    this._userBtn.append(this._avatar, who, createIcon('chevron-down', { size: 16, doc, className: 'fx-icon fx-shell-caret' }));
    this._userBtn.addEventListener('click', () => this.setMenuOpen(this._userBtn.getAttribute('aria-expanded') !== 'true'));
    this._menu = el('div', 'fx-shell-menu', { role: 'menu', id: `${this._id}-menu`, 'aria-label': kt('shell.signedInAs') });
    this._menu.hidden = true;
    this._menuHead = el('div', 'fx-shell-menuhead', { role: 'presentation' });
    this._menuExtra = el('div', 'fx-shell-menuextra', { role: 'presentation' });
    this._signout = el('button', 'fx-shell-menuitem', { type: 'button', role: 'menuitem', tabindex: '-1' });
    this._signout.append(createIcon('logout', { size: 18, doc }), doc.createTextNode(kt('shell.signOut')));
    this._signout.addEventListener('click', () => { this.setMenuOpen(false); this.dispatchEvent(new CustomEvent('fx-signout', { bubbles: true, composed: true })); });
    this._menu.append(this._menuHead, this._menuExtra, el('div', 'fx-shell-menusep', { role: 'separator' }), this._signout);
    this._menu.addEventListener('keydown', (e) => this.onMenuKey(e));
    this._user.append(this._userBtn, this._menu);
    inner.append(this._toggle, this._brand, this._nav, spacer, this._user);
    top.appendChild(inner);
    this._sticky.append(this._demo, top);

    this._main = el('div', 'fx-shell-main');
    this._head = el('div', 'fx-shell-pagehead');
    const titles = el('div', 'fx-shell-titles');
    this._h1 = el('h1', 'fx-shell-title', { id: `${this._id}-title` });
    this._sub = el('p', 'fx-shell-subtitle');
    titles.append(this._h1, this._sub);
    this._actions = el('div', 'fx-shell-actions');
    this._head.append(titles, this._actions);
    this._content = el('div', 'fx-shell-content');
    this._main.append(this._head, this._content);
    this.append(this._sticky, this._main);

    this._regions = new Set([this._sticky, this._main]);
    for (const n of existing) this.place(n);
    if (this._navItems) this.navItems = this._navItems;
    this.update();

    if (typeof MutationObserver !== 'undefined') {
      this._mo = new MutationObserver((recs) => {
        for (const r of recs) for (const n of r.addedNodes) if (n.parentNode === this && !this._regions.has(n)) this.place(n);
        this.syncRegions();
      });
      this._mo.observe(this, { childList: true });
      this._mo2 = new MutationObserver(() => this.syncRegions());
      this._mo2.observe(this._demo, { childList: true });
    }
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.syncDemoHeight());
      this._ro.observe(this._demo);
    }
    const mq = globalThis.matchMedia?.('(min-width: 768px)');
    if (mq) { this._mq = mq; this._onMq = () => { if (mq.matches) this.setNavOpen(false); }; mq.addEventListener?.('change', this._onMq); }
    this.syncRegions();
  }

  /** Move a node into the region its slot attribute names. */
  place(n) {
    const slot = n.nodeType === 1 ? n.getAttribute('slot') : null;
    if (slot === 'demo') this._demo.appendChild(n);
    else if (slot === 'nav') this._nav.appendChild(n);
    else if (slot === 'actions') this._actions.appendChild(n);
    else if (slot === 'user-menu') {
      if (n.nodeType === 1 && !n.getAttribute('role')) n.setAttribute('role', 'menuitem');
      if (n.nodeType === 1) { n.tabIndex = -1; n.classList.add('fx-shell-menuitem'); }
      this._menuExtra.appendChild(n);
    } else this._content.appendChild(n);
  }

  syncRegions() {
    if (!this._built) return;
    const hasDemo = [...this._demo.childNodes].some((n) => n.nodeType === 1);
    this._demo.hidden = !hasDemo;
    this.toggleAttribute('data-has-demo', hasDemo);
    this._toggle.hidden = !this._nav.children.length;
    this.toggleAttribute('data-has-nav', this._nav.children.length > 0);
    this.syncHead();
    this.syncDemoHeight();
  }

  syncHead() {
    const hasTitle = !!this.getAttribute('heading');
    this._head.hidden = !hasTitle && !this._actions.children.length;
  }

  syncDemoHeight() {
    const h = this._demo.hidden ? 0 : Math.round(this._demo.getBoundingClientRect?.().height ?? 0);
    const v = `${h}px`;
    this.style.setProperty('--fx-demo-height', v);
    this.ownerDocument.documentElement?.style?.setProperty('--fx-demo-height', v);
  }

  update() {
    const g = (n) => this.getAttribute(n) ?? '';
    const product = g('product');
    const tenant = g('tenant-name');
    this._product.textContent = product;
    this._tenant.textContent = tenant;
    this._tenant.hidden = !tenant;
    this._brand.setAttribute('href', g('home-href') || '#');
    this._brand.setAttribute('aria-label', [product, tenant].filter(Boolean).join(', ') || 'Home');
    this._mark.textContent = '';
    const logo = g('logo');
    if (logo && /^(\/|\.\/)?[A-Za-z0-9._/-]+$/.test(logo) && !logo.includes('..')) {
      const img = this.ownerDocument.createElement('img'); img.src = logo; img.alt = ''; this._mark.appendChild(img); this._mark.dataset.logo = '';
    } else { this._mark.textContent = initials(tenant || product); delete this._mark.dataset.logo; }
    this._nav.setAttribute('aria-label', g('nav-label') || kt('shell.primaryNav'));
    this._h1.textContent = g('heading');
    this._sub.textContent = g('subheading');
    this._sub.hidden = !g('subheading');
    const name = g('user-name');
    const role = roleLabel(g('user-role'));
    this._user.hidden = !name;
    this._avatar.textContent = initials(name);
    this._userName.textContent = name;
    this._userRole.textContent = role;
    this._userBtn.setAttribute('aria-label', kt('shell.userMenu', { name: [name, role].filter(Boolean).join(', ') }));
    const doc = this.ownerDocument;
    this._menuHead.textContent = '';
    const big = doc.createElement('span'); big.className = 'fx-avatar fx-avatar-lg'; big.setAttribute('aria-hidden', 'true'); big.textContent = initials(name);
    const txt = doc.createElement('div');
    const n = doc.createElement('div'); n.className = 'fx-shell-menuname'; n.textContent = name;
    const r = doc.createElement('div'); r.className = 'fx-shell-menumeta'; r.textContent = [role, tenant].filter(Boolean).join(' · ');
    txt.append(n, r);
    this._menuHead.append(big, txt);
    this._signout.hidden = this.hasAttribute('no-signout');
    this.syncHead();
  }

  menuItems() { return [...this._menu.querySelectorAll('[role="menuitem"]')].filter((m) => !m.hidden); }

  setMenuOpen(open, { focus = true } = {}) {
    this._menu.hidden = !open;
    this._userBtn.setAttribute('aria-expanded', String(open));
    if (open) { this.setNavOpen(false); if (focus) this.menuItems()[0]?.focus(); }
  }

  setNavOpen(open) {
    this.toggleAttribute('data-nav-open', open);
    this._toggle.setAttribute('aria-expanded', String(open));
    this._toggle.setAttribute('aria-label', kt(open ? 'shell.closeNav' : 'shell.openNav'));
    const ic = createIcon(open ? 'x' : 'menu', { size: 20, doc: this.ownerDocument });
    this._toggle.textContent = ''; if (ic) this._toggle.appendChild(ic);
  }

  onMenuKey(e) {
    const items = this.menuItems();
    const i = items.indexOf(this.ownerDocument.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); this.setMenuOpen(false); this._userBtn.focus(); return; }
    if (e.key === 'Tab') { this.setMenuOpen(false, { focus: false }); return; }
    const n = menuIndex(i < 0 ? -1 : i, e.key, items.length);
    if (n !== null) { e.preventDefault(); items[n]?.focus(); }
  }

  onDocument(e) {
    if (e.type === 'keydown') {
      if (e.key === 'Escape' && this.hasAttribute('data-nav-open')) { this.setNavOpen(false); this._toggle.focus(); }
      if (e.key === 'ArrowDown' && e.target === this._userBtn) { e.preventDefault(); this.setMenuOpen(true); }
      return;
    }
    // composedPath, not e.target: the toggle swaps its icon during the click, detaching the original target.
    const path = e.composedPath?.() ?? [e.target];
    if (!this._menu.hidden && !path.includes(this._user)) this.setMenuOpen(false, { focus: false });
    if (this.hasAttribute('data-nav-open') && !path.includes(this._nav) && !path.includes(this._toggle)) this.setNavOpen(false);
  }
}
