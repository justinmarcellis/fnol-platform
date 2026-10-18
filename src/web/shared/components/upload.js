import { t } from '../i18n.js';
const HE = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

/** Does a file's type match an `accept` list ("image/*,application/pdf,.heic")? Pure. */
export function acceptsType(file, accept) {
  if (!accept) return true;
  const type = (file.type ?? '').toLowerCase();
  const name = (file.name ?? '').toLowerCase();
  return accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((a) => {
    if (a.startsWith('.')) return name.endsWith(a);
    if (a.endsWith('/*')) return type.startsWith(a.slice(0, -1));
    return type === a;
  });
}

/**
 * Validate files against constraints. Pure.
 * @returns {{accepted:object[], errors:string[]}}
 */
export function validateFiles(files, { accept = '', maxSizeMb = 25, max = 10, existing = 0 } = {}) {
  const accepted = [];
  const errors = [];
  for (const f of files) {
    if (existing + accepted.length >= max) { errors.push(t('kit.upload.tooMany', { max })); break; }
    if (!acceptsType(f, accept)) { errors.push(t('kit.upload.badType', { name: f.name })); continue; }
    if (f.size > maxSizeMb * 1024 * 1024) { errors.push(t('kit.upload.tooLarge', { name: f.name, max: maxSizeMb })); continue; }
    accepted.push(f);
  }
  return { accepted, errors };
}

/**
 * <fx-upload accept="image/*,application/pdf" max="10" max-size-mb="25" multiple label>
 * Emits fx-change {files}. Image previews use object URLs which are revoked on remove and disconnect.
 */
export class FxUpload extends HE {
  constructor() { super(); this.files = []; this._urls = new Map(); }
  connectedCallback() { this.render(); }
  disconnectedCallback() { this.revokeAll(); }
  revokeAll() {
    for (const u of this._urls.values()) globalThis.URL?.revokeObjectURL?.(u);
    this._urls.clear();
  }
  add(list) {
    const { accepted, errors } = validateFiles(Array.from(list), {
      accept: this.getAttribute('accept') ?? '',
      maxSizeMb: Number(this.getAttribute('max-size-mb')) || 25,
      max: Number(this.getAttribute('max')) || 10,
      existing: this.files.length,
    });
    for (const f of accepted) {
      this.files.push(f);
      if ((f.type ?? '').startsWith('image/')) this._urls.set(f, globalThis.URL.createObjectURL(f));
    }
    this._errors = errors;
    this.render();
    this.dispatchEvent(new CustomEvent('fx-change', { bubbles: true, detail: { files: [...this.files], errors } }));
  }
  remove(file) {
    const u = this._urls.get(file);
    if (u) { globalThis.URL.revokeObjectURL(u); this._urls.delete(file); }
    this.files = this.files.filter((f) => f !== file);
    this.render();
    this.dispatchEvent(new CustomEvent('fx-change', { bubbles: true, detail: { files: [...this.files], errors: [] } }));
  }
  render() {
    const doc = this.ownerDocument;
    this.textContent = '';
    const drop = doc.createElement('div');
    drop.className = 'fx-drop';
    const input = doc.createElement('input');
    input.type = 'file';
    input.className = 'fx-visually-hidden';
    input.id = `fxu${Math.random().toString(36).slice(2, 8)}`;
    if (this.getAttribute('accept')) input.accept = this.getAttribute('accept');
    if (this.hasAttribute('multiple')) input.multiple = true;
    input.addEventListener('change', () => { this.add(input.files); });
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = this.getAttribute('label') ?? t('kit.upload.drop');
    btn.addEventListener('click', () => input.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.dataset.over = ''; });
    drop.addEventListener('dragleave', () => { delete drop.dataset.over; });
    drop.addEventListener('drop', (e) => { e.preventDefault(); delete drop.dataset.over; this.add(e.dataTransfer?.files ?? []); });
    drop.append(input, btn);
    this.appendChild(drop);
    const status = doc.createElement('div');
    status.setAttribute('role', 'alert');
    status.className = 'fx-error';
    status.textContent = (this._errors ?? []).join(' ');
    this.appendChild(status);
    const ul = doc.createElement('ul');
    for (const f of this.files) {
      const li = doc.createElement('li');
      const url = this._urls.get(f);
      if (url) { const img = doc.createElement('img'); img.src = url; img.alt = t('kit.upload.preview', { name: f.name }); li.appendChild(img); }
      const name = doc.createElement('span'); name.textContent = f.name;
      const rm = doc.createElement('button');
      rm.type = 'button'; rm.textContent = '×'; rm.setAttribute('aria-label', t('kit.upload.remove', { name: f.name }));
      rm.addEventListener('click', () => this.remove(f));
      li.append(name, rm);
      ul.appendChild(li);
    }
    this.appendChild(ul);
  }
}
