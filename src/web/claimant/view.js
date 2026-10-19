// Browser-only DOM helpers for the claimant app. All user/server text goes through textContent.
import { localText } from './strings.js';
import { isStructured, structuredFields, buildStructured, missingStructured } from './structured.js';
import { validateScalar } from './present.js';
import { validateFile, ACCEPT_ATTR, MAX_BYTES } from './upload.js';
import { pluralKey } from './strings.js';
import { createIcon } from '/shared/icons.js';

/** Tiny element builder: attrs with `on*` become listeners, `text` sets textContent. */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

let uid = 0;
/** Inline error paragraph (alert icon + text). Hidden until setError is called. */
function errorLine(id) {
  const p = h('p', { class: 'field-error', id, role: 'alert', hidden: true });
  const set = (text) => {
    p.replaceChildren();
    if (text) p.append(h('span', { class: 'cl-err-icon' }, createIcon('alert-circle', { size: 16 })), h('span', { text }));
    p.hidden = !text;
  };
  return { el: p, set };
}

/**
 * Build the input for one question. Returns { el, get(), focus(), setError(text), check() }.
 * Value types follow the Question schema; the server validates.
 */
export function buildInput(question, { locale, t, errorId, initial, today }) {
  if (isStructured(question)) return buildStructuredInput(question, { locale, t, errorId, initial });
  if (question.type === 'media') return buildMediaInput(question, { locale, t, errorId, initial });
  const id = `q-${++uid}`;
  const label = localText(question.text, locale);
  const help = localText(question.help, locale);
  const helpId = help ? `${id}-help` : null;
  const msgId = `${id}-msg`;
  const describedBy = [helpId, errorId, msgId].filter(Boolean).join(' ');
  const req = question.required ? null : t('claimant.guided.optional');
  const type = question.type;
  const options = question.options ?? [];
  const err = errorLine(msgId);
  let get; let control;

  if (type === 'boolean' || (type === 'select' && options.length > 0 && options.length <= 4) || type === 'multiselect' || type === 'disclosure') {
    let items; let kind = 'radio';
    if (type === 'boolean') items = [{ value: 'true', label: t('claimant.guided.yes') }, { value: 'false', label: t('claimant.guided.no') }];
    else if (type === 'disclosure') { kind = 'check'; items = [{ value: 'ack', label: t('claimant.guided.acknowledge') }]; }
    else { items = options.map((o) => ({ value: o.value, label: localText(o.label, locale) })); if (type === 'multiselect') kind = 'check'; }
    const fs = h('fieldset', { class: 'cl-qfield', 'aria-describedby': describedBy });
    fs.append(h('legend', { class: 'cl-qlabel', text: label + (req ? ` ${req}` : '') }));
    if (help) fs.append(h('p', { class: 'help', id: helpId, text: help }));
    const group = h('div', { class: `cl-opts${items.length === 2 ? ' two' : ''}` });
    const pre = new Set([].concat(initial ?? []).map(String));
    items.forEach((o, i) => {
      const inp = h('input', { type: kind === 'check' ? 'checkbox' : 'radio', name: id, value: o.value, id: `${id}-${i}`, checked: pre.has(o.value) || (type === 'disclosure' && initial === true) || null });
      group.append(h('label', { class: 'cl-opt', for: `${id}-${i}` }, inp, h('span', { class: 'cl-opt-text', text: o.label })));
    });
    fs.append(group, err.el);
    get = () => {
      const checked = [...fs.querySelectorAll('input:checked')].map((i) => i.value);
      if (type === 'boolean') return checked.length ? checked[0] === 'true' : undefined;
      if (type === 'disclosure') return checked.length ? true : undefined;
      if (type === 'multiselect') return checked.length ? checked : undefined;
      return checked[0];
    };
    return {
      el: fs, get, raw: () => { const v = get(); return v === undefined ? undefined : typeof v === 'boolean' && type !== 'disclosure' ? String(v) : v; },
      focus: () => fs.querySelector('input')?.focus(),
      setError(text) { err.set(text); fs.querySelectorAll('input').forEach((i) => (text ? i.setAttribute('aria-invalid', 'true') : i.removeAttribute('aria-invalid'))); },
      check: () => true,
    };
  }

  if (type === 'select') {
    control = h('select', { id, 'aria-describedby': describedBy }, h('option', { value: '', text: '' }), options.map((o) => h('option', { value: o.value, text: localText(o.label, locale) })));
    get = () => control.value || undefined;
  } else if (type === 'longtext') {
    control = h('textarea', { id, 'aria-describedby': describedBy, rows: 5 });
    get = () => control.value.trim() || undefined;
  } else {
    const htmlType = { number: 'number', currency: 'number', date: 'date', time: 'time', datetime: 'datetime-local', phone: 'tel', email: 'email' }[type] ?? 'text';
    const extra = type === 'currency' || type === 'number' ? { inputmode: 'decimal', step: 'any' } : {};
    control = h('input', { type: htmlType, id, 'aria-describedby': describedBy, autocomplete: type === 'phone' ? 'tel' : type === 'email' ? 'email' : 'off', ...extra });
    get = () => {
      const v = control.value.trim();
      if (!v) return undefined;
      return htmlType === 'number' ? Number(v) : v;
    };
  }
  if (initial !== undefined && initial !== null && typeof initial !== 'object') control.value = String(initial);
  const setError = (text) => { err.set(text); if (text) control.setAttribute('aria-invalid', 'true'); else control.removeAttribute('aria-invalid'); };
  control.addEventListener('input', () => { if (!err.el.hidden) setError(''); });
  const el = h('div', { class: 'cl-qfield' },
    h('label', { for: id, class: 'cl-qlabel legend', text: label + (req ? ` ${req}` : '') }),
    help ? h('p', { class: 'help', id: helpId, text: help }) : null,
    control, err.el);
  return {
    el, get, raw: () => control.value, focus: () => control.focus(), setError,
    check() {
      const key = validateScalar(type, control.value, question, { today });
      if (key) { setError(t(key)); control.focus(); return false; }
      return true;
    },
  };
}

/**
 * Media question (photos): a file picker inside the question form. Files cannot be uploaded before the claim exists, so
 * get() returns their descriptions ({ fileName, contentType, size }) as the answer and files() the File objects, which the
 * app uploads to /claims/{id}/documents right after submit. Unsupported or oversized files are listed and left out.
 */
export function buildMediaInput(question, { locale, t, errorId, initial }) {
  const id = `md-${++uid}`;
  const label = localText(question.text, locale);
  const help = localText(question.help, locale) || t('claimant.media.help');
  const msgId = `${id}-msg`;
  const err = errorLine(msgId);
  let files = Array.isArray(initial?.files) ? [...initial.files] : [];
  const rejected = [];
  const list = h('ul', { class: 'cl-files', 'aria-live': 'polite' });
  const count = h('p', { class: 'help', id: `${id}-count` });
  const paint = () => {
    list.replaceChildren(...files.map((f) => h('li', { class: 'ok' }, h('span', { class: 'cl-fileicon', 'aria-hidden': 'true' }, createIcon('file', { size: 18 })), h('span', { text: f.name }))),
      ...rejected.map((name) => h('li', { class: 'bad' }, h('span', { class: 'cl-fileicon', 'aria-hidden': 'true' }, createIcon('alert-circle', { size: 18 })), h('span', { text: t('claimant.media.rejected', { name, max: MAX_BYTES / 1048576 }) }))));
    count.textContent = files.length ? t(pluralKey('claimant.media.count', files.length), { n: files.length }) : '';
  };
  const picker = h('input', { type: 'file', id, class: 'sr-only', multiple: true, accept: ACCEPT_ATTR, 'aria-describedby': [`${id}-help`, `${id}-count`, errorId, msgId].filter(Boolean).join(' '), onchange: () => {
    rejected.length = 0;
    for (const f of [...(picker.files ?? [])]) { if (validateFile(f).ok) files.push(f); else rejected.push(f.name); }
    try { picker.value = ''; } catch { /* some browsers keep the selection */ }
    err.set(''); paint();
  } });
  const req = question.required ? '' : ` ${t('claimant.guided.optional')}`;
  const fs = h('fieldset', { class: 'cl-qfield', 'data-qtype': 'media' },
    h('legend', { class: 'cl-qlabel', text: label + req }),
    h('p', { class: 'help', id: `${id}-help`, text: help }),
    h('label', { class: 'cl-drop', for: id }, picker, createIcon('upload', { size: 24 }), h('span', { text: t('claimant.media.choose') })),
    count, list, err.el);
  paint();
  return {
    el: fs,
    get: () => (files.length ? files.map((f) => ({ fileName: f.name, contentType: f.type, size: f.size })) : undefined),
    files: () => [...files],
    raw: () => ({ files: [...files] }),
    setError: (text) => err.set(text),
    check: () => true,
    focus: () => picker.focus(),
  };
}

/**
 * Structured sub-form for party, vehicle and address questions: one labelled control per field in a fieldset.
 * get() returns the answer object (undefined when every field is empty); check() shows an inline message and returns false
 * when a required field is empty; raw() returns the entered values so a re-render after a server 422 keeps them.
 */
export function buildStructuredInput(question, { locale, t, errorId, initial = {} }) {
  const id = `sf-${++uid}`;
  const label = localText(question.text, locale) || t(`claimant.sf.legend.${question.type}`);
  const help = localText(question.help, locale);
  const msgId = `${id}-msg`;
  const errBox = errorLine(msgId);
  const msg = errBox.el;
  const fs = h('fieldset', { id, class: 'sf cl-qfield', 'data-qtype': question.type, 'aria-describedby': [errorId, msgId].filter(Boolean).join(' ') });
  fs.append(h('legend', { class: 'cl-qlabel', text: label }));
  if (help) fs.append(h('p', { class: 'help', text: help }));
  const ctl = {};
  for (const fd of structuredFields(question.type)) {
    const cid = `${id}-${fd.key}`;
    const text = t(`claimant.sf.${fd.key}`);
    if (fd.input === 'checkbox') {
      const cb = h('input', { type: 'checkbox', id: cid, name: fd.key, checked: initial[fd.key] === true || null });
      ctl[fd.key] = cb;
      fs.append(h('label', { class: 'cl-opt', for: cid }, cb, h('span', { class: 'cl-opt-text', text })));
      continue;
    }
    let c;
    if (fd.input === 'select') {
      c = h('select', { id: cid, name: fd.key, 'aria-required': fd.required ? 'true' : null },
        fd.options.map((o) => h('option', { value: o, text: t(`claimant.sf.role.${o}`), selected: (initial[fd.key] ?? fd.options[0]) === o || null })));
    } else {
      c = h('input', { type: fd.input === 'number' ? 'number' : fd.input, id: cid, name: fd.key, autocomplete: fd.autocomplete ?? 'off', value: initial[fd.key] ?? null, 'aria-required': fd.required ? 'true' : null });
    }
    ctl[fd.key] = c;
    fs.append(h('div', { class: 'sf-field' }, h('label', { for: cid, text: text + (fd.required ? '' : ` (${t('claimant.sf.optional')})`) }), c));
  }
  fs.append(msg);
  const raw = () => Object.fromEntries(Object.entries(ctl).map(([k, c]) => [k, c.type === 'checkbox' ? c.checked : c.value]));
  const show = (text, first) => {
    errBox.set(text);
    for (const [k, c] of Object.entries(ctl)) { if (k === first) c.setAttribute('aria-invalid', 'true'); else c.removeAttribute('aria-invalid'); }
  };
  return {
    el: fs,
    raw,
    setError: (text) => show(text, null),
    get() {
      const r = raw();
      if (!Object.entries(r).some(([k, v]) => v === true || (typeof v === 'string' && v.trim() && !(k === 'role')))) return undefined;
      return buildStructured(question.type, r);
    },
    check() {
      const { ok, missing } = missingStructured(question.type, raw());
      if (!ok) {
        show(t('claimant.sf.required', { label: missing.map((k) => t(`claimant.sf.${k}`)).join(', ') }), missing[0]);
        ctl[missing[0]]?.focus();
      } else show('');
      return ok;
    },
    focus: () => Object.values(ctl)[0]?.focus()
  };
}

/**
 * Render the claim stages as a vertical stepper: a semantic ordered list with exactly one aria-current step.
 * The current step carries a short "what happens next" sentence and the time it last changed.
 * @param {{ id: string, label: string, state: string, stateLabel: string, at?: string, attention?: boolean }[]} items from buildTimeline
 * @param {Function} t
 * @param {{ icon?: (name: string, size?: number) => Node|null, time?: (iso: string) => string, next?: (id: string) => string }} [deps]
 */
export function renderStages(items, t, { icon = () => null, time = (v) => v, next = () => '' } = {}) {
  return h('ol', { class: 'timeline cl-steps', 'aria-label': t('claimant.next.heading') }, items.map((i, n) => {
    const dot = h('span', { class: 'cl-dot', 'aria-hidden': 'true' }, i.state === 'done' ? icon('check', 16) : h('span', { class: 'cl-dot-n', text: String(n + 1) }));
    const body = h('div', { class: 'cl-step-body' },
      h('span', { class: 'cl-step-title', text: i.label }),
      i.state !== 'upcoming' && i.at ? h('span', { class: 'cl-step-when', text: time(i.at) }) : null,
      i.state === 'current' ? h('span', { class: 'cl-step-desc', text: next(i.id) }) : null,
      h('span', { class: 'sr-only', text: `, ${i.stateLabel}` }));
    return h('li', { class: `${i.state}${i.attention ? ' attention' : ''}`, 'aria-current': i.state === 'current' ? 'step' : null }, dot, body);
  }));
}

/** The kit's fx-timeline activity log (reported and latest update), or null when the kit is not loaded. */
export function renderActivity(claim, t) {
  if (typeof customElements === 'undefined' || !customElements.get('fx-timeline') || !claim) return null;
  const events = [];
  if (claim.reportedAt) events.push({ at: claim.reportedAt, title: t('claimant.status.reported'), tone: 'success' });
  if (claim.updatedAt && claim.status !== 'reported') events.push({ at: claim.updatedAt, title: t(`claimant.status.${claim.status}`), tone: 'brand' });
  const el = document.createElement('fx-timeline');
  el.events = events;
  return el;
}
