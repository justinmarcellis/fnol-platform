// Browser-only DOM helpers for the claimant app. All user/server text goes through textContent.
import { localText } from './strings.js';
import { isStructured, structuredFields, buildStructured, missingStructured } from './structured.js';

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
/**
 * Build the input for one question. Returns { el, get(), focus() }.
 * Value types follow the Question schema; the server validates.
 */
export function buildInput(question, { locale, t, errorId, initial }) {
  if (isStructured(question)) return buildStructuredInput(question, { locale, t, errorId, initial });
  const id = `q-${++uid}`;
  const label = localText(question.text, locale);
  const help = localText(question.help, locale);
  const helpId = help ? `${id}-help` : null;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || null;
  const req = question.required ? null : t('claimant.guided.optional');
  const type = question.type;
  const options = question.options ?? [];
  let get; let focusEl;
  let control;

  if (type === 'boolean' || (type === 'select' && options.length > 0 && options.length <= 4) || type === 'multiselect' || type === 'disclosure') {
    let items; let kind = 'radio';
    if (type === 'boolean') items = [{ value: 'true', label: t('claimant.guided.yes') }, { value: 'false', label: t('claimant.guided.no') }];
    else if (type === 'disclosure') { kind = 'check'; items = [{ value: 'ack', label: t('claimant.guided.acknowledge') }]; }
    else { items = options.map((o) => ({ value: o.value, label: localText(o.label, locale) })); if (type === 'multiselect') kind = 'check'; }
    const fs = h('fieldset', { 'aria-describedby': describedBy });
    fs.append(h('legend', { text: label + (req ? ` ${req}` : '') }));
    if (help) fs.append(h('p', { class: 'help', id: helpId, text: help }));
    items.forEach((o, i) => {
      const inp = h('input', { type: kind === 'check' ? 'checkbox' : 'radio', name: id, value: o.value, id: `${id}-${i}` });
      fs.append(h('label', { class: 'opt', for: `${id}-${i}` }, inp, h('span', { text: o.label })));
    });
    focusEl = () => fs.querySelector('input');
    get = () => {
      const checked = [...fs.querySelectorAll('input:checked')].map((i) => i.value);
      if (type === 'boolean') return checked.length ? checked[0] === 'true' : undefined;
      if (type === 'disclosure') return checked.length ? true : undefined;
      if (type === 'multiselect') return checked.length ? checked : undefined;
      return checked[0];
    };
    return { el: fs, get, focus: () => focusEl()?.focus() };
  }

  if (type === 'select') {
    control = h('select', { id, 'aria-describedby': describedBy }, h('option', { value: '', text: '' }), options.map((o) => h('option', { value: o.value, text: localText(o.label, locale) })));
    get = () => control.value || undefined;
  } else if (type === 'longtext') {
    control = h('textarea', { id, 'aria-describedby': describedBy, rows: 4 });
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
  const el = h('div', {},
    h('label', { for: id, class: 'legend', text: label + (req ? ` ${req}` : '') }),
    help ? h('p', { class: 'help', id: helpId, text: help }) : null,
    control);
  return { el, get, focus: () => control.focus() };
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
  const msg = h('p', { class: 'field-error', id: msgId, role: 'alert', hidden: true });
  const fs = h('fieldset', { id, class: 'sf', 'data-qtype': question.type, 'aria-describedby': [errorId, msgId].filter(Boolean).join(' ') });
  fs.append(h('legend', { text: label }));
  if (help) fs.append(h('p', { class: 'help', text: help }));
  const ctl = {};
  for (const fd of structuredFields(question.type)) {
    const cid = `${id}-${fd.key}`;
    const text = t(`claimant.sf.${fd.key}`);
    if (fd.input === 'checkbox') {
      const cb = h('input', { type: 'checkbox', id: cid, name: fd.key, checked: initial[fd.key] === true || null });
      ctl[fd.key] = cb;
      fs.append(h('label', { class: 'opt', for: cid }, cb, h('span', { text })));
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
    msg.textContent = text || ''; msg.hidden = !text;
    for (const [k, c] of Object.entries(ctl)) { if (k === first) c.setAttribute('aria-invalid', 'true'); else c.removeAttribute('aria-invalid'); }
  };
  return {
    el: fs,
    raw,
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
 * Render the status timeline: a semantic stage list, plus the kit's fx-timeline activity log
 * (reported / latest update) when the kit registered it.
 */
export function renderTimeline(items, claim, t) {
  const stages = h('ol', { class: 'timeline', 'aria-label': t('claimant.status.heading') }, items.map((i) =>
    h('li', { class: `${i.state}${i.attention ? ' attention' : ''}`, 'aria-current': i.state === 'current' ? 'step' : null },
      h('span', { text: i.label }), h('span', { class: 'sr-only', text: `, ${i.stateLabel}` }))));
  const wrap = h('div', {}, stages);
  if (typeof customElements !== 'undefined' && customElements.get('fx-timeline') && claim) {
    const events = [];
    if (claim.reportedAt) events.push({ at: claim.reportedAt, title: t('claimant.status.reported') });
    if (claim.updatedAt && claim.status !== 'reported') events.push({ at: claim.updatedAt, title: t(`claimant.status.${claim.status}`) });
    const el = document.createElement('fx-timeline');
    el.events = events;
    wrap.append(el);
  }
  return wrap;
}
