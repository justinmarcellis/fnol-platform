import { t } from '../i18n.js';
const HE = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

/** Normalize a message. Pure. role: 'user' | 'assistant' | 'system'. */
export function makeMessage(role, text, extra = {}) {
  return { id: extra.id ?? `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, role, text: String(text ?? ''), ...extra };
}

/** Speaker label for a role. Pure. */
export function speakerLabel(role) {
  return role === 'user' ? t('kit.chat.you') : role === 'assistant' ? t('kit.chat.assistant') : '';
}

/**
 * <fx-chat> message log (role=log, aria-live polite) with an input form.
 * API: addMessage(role,text,extra), setTyping(bool). Emits fx-submit {text}. AI messages may carry
 * extra.provider/model/confidence/explanation, shown as a caption (standards: never show AI output without them).
 */
export class FxChat extends HE {
  constructor() { super(); this.messages = []; this._typing = false; }
  connectedCallback() { this.render(); }
  addMessage(role, text, extra) { const m = makeMessage(role, text, extra); this.messages.push(m); if (this.isConnected) this.render(); return m; }
  setTyping(on) { this._typing = !!on; if (this.isConnected) this.render(); }
  render() {
    const doc = this.ownerDocument;
    this.textContent = '';
    const log = doc.createElement('div');
    log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite'); log.setAttribute('aria-label', t('kit.chat.log'));
    log.tabIndex = 0;
    for (const m of this.messages) {
      const d = doc.createElement('div');
      d.className = 'fx-msg'; d.dataset.role = m.role;
      const who = speakerLabel(m.role);
      if (who) { const s = doc.createElement('span'); s.className = 'fx-visually-hidden'; s.textContent = `${who}: `; d.appendChild(s); }
      d.appendChild(doc.createTextNode(m.text));
      if (m.role === 'assistant' && m.provider) {
        const c = doc.createElement('small');
        c.textContent = ` ${m.provider}/${m.model ?? ''}${m.confidence != null ? ` ${Math.round(m.confidence * 100)}%` : ''}${m.explanation ? ` - ${m.explanation}` : ''}`;
        d.appendChild(c);
      }
      log.appendChild(d);
    }
    if (this._typing) { const p = doc.createElement('div'); p.className = 'fx-msg'; p.setAttribute('role', 'status'); p.textContent = `${t('kit.chat.typing')}...`; log.appendChild(p); }
    this.appendChild(log);
    const form = doc.createElement('form');
    const input = doc.createElement('input');
    input.type = 'text'; input.name = 'text'; input.setAttribute('aria-label', t('kit.chat.placeholder')); input.placeholder = t('kit.chat.placeholder'); input.autocomplete = 'off';
    const btn = doc.createElement('button');
    btn.type = 'submit'; btn.textContent = t('kit.chat.send');
    form.append(input, btn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      this.dispatchEvent(new CustomEvent('fx-submit', { bubbles: true, detail: { text } }));
    });
    this.appendChild(form);
    log.scrollTop = log.scrollHeight;
  }
}
