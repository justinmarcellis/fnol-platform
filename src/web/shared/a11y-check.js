// Framework-free accessibility checks. Findings are advisory warnings: callers report them and never fail on them.
// checkDocument is fully self-contained (no outer references) so its source can be shipped to a browser with
// page.evaluate(`(${checkDocument})(document)`). It also runs in node against a minimal fake DOM.

/**
 * Relative luminance of a #rrggbb (or #rgb) colour.
 * @param {string} hex
 * @returns {number}
 */
export function luminance(hex) {
  const h = String(hex).trim().replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return NaN;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG 2.x contrast ratio between two hex colours (1 to 21). NaN when a colour is not hex.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Minimum contrast for normal text (WCAG AA). */
export const TEXT_MIN = 4.5;

/** Foreground/background token pairs checked in tokens.css. */
export const TOKEN_PAIRS = [
  ['--fx-text', '--fx-bg'], ['--fx-text', '--fx-surface'], ['--fx-text', '--fx-surface-2'],
  ['--fx-text-muted', '--fx-bg'], ['--fx-text-muted', '--fx-surface'],
  ['--fx-on-brand', '--fx-brand'], ['--fx-on-accent', '--fx-accent'],
  ['--fx-brand', '--fx-bg'], ['--fx-danger', '--fx-bg'], ['--fx-success', '--fx-bg'], ['--fx-warning', '--fx-bg'],
];

/**
 * Check foreground/background pairs in a flat token object ({'--fx-text': '#14202e', ...}). Pairs with a
 * missing or non-hex side are skipped. Returns warnings for pairs under 4.5:1.
 * @param {Record<string,string>} tokens
 * @param {{ pairs?: string[][], min?: number, scope?: string }} [opts]
 */
export function checkTokens(tokens, { pairs = TOKEN_PAIRS, min = TEXT_MIN, scope = 'tokens' } = {}) {
  const findings = [];
  for (const [fg, bg] of pairs) {
    const ratio = contrastRatio(tokens?.[fg], tokens?.[bg]);
    if (Number.isNaN(ratio)) continue;
    if (ratio < min) findings.push({ rule: 'contrast-token', severity: 'warning', target: `${scope}: ${fg} on ${bg}`, message: `${fg} ${tokens[fg]} on ${bg} ${tokens[bg]} is ${ratio.toFixed(2)}:1, below ${min}:1`, ratio });
  }
  return findings;
}

/**
 * Parse custom properties out of tokens.css text. Returns the light defaults plus the dark overrides
 * (from [data-theme='dark'], merged over the defaults).
 * @param {string} css
 * @returns {{ light: Record<string,string>, dark: Record<string,string> }}
 */
export function parseTokensCss(css) {
  const props = (body) => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const blockAfter = (re) => { const m = re.exec(css); return m ? props(m[1]) : {}; };
  const light = blockAfter(/(?:^|\n):root\s*\{([^}]*)\}/);
  const darkOnly = blockAfter(/:root\[data-theme=['"]dark['"]\]\s*\{([^}]*)\}/);
  return { light, dark: { ...light, ...darkOnly } };
}

/**
 * Check a tenant's branding pair: the text colour a UI would put on primary/accent (white or near-black,
 * whichever is better) and the brand colours as text on a white page.
 * @param {{ primaryColor?: string, accentColor?: string }} branding
 * @param {string} [scope]
 */
export function checkBranding(branding, scope = 'branding') {
  const findings = [];
  for (const key of ['primaryColor', 'accentColor']) {
    const bg = branding?.[key];
    if (Number.isNaN(luminance(bg))) continue;
    const best = Math.max(contrastRatio(bg, '#ffffff'), contrastRatio(bg, '#111111'));
    if (best < TEXT_MIN) findings.push({ rule: 'contrast-brand', severity: 'warning', target: `${scope}: ${key}`, message: `${key} ${bg} reaches only ${best.toFixed(2)}:1 with the best text colour`, ratio: best });
  }
  return findings;
}

/**
 * Scan a Document or root element for common accessibility problems. Self-contained on purpose.
 * Checks: form control labels, image alt, landmarks and h1, html lang, and (when a window with
 * getComputedStyle is available) text contrast.
 * @param {Document|Element} root
 * @param {{ contrast?: boolean, maxContrastNodes?: number }} [opts]
 * @returns {{ rule: string, severity: 'warning', target: string, message: string }[]}
 */
export function checkDocument(root, opts = {}) {
  const out = [];
  const warn = (rule, target, message) => out.push({ rule, severity: 'warning', target, message });
  const all = (sel) => Array.from(root.querySelectorAll(sel));
  const attr = (el, name) => (el.getAttribute(name) || '').trim();
  const name = (el) => `${String(el.tagName || '').toLowerCase()}${el.id ? `#${el.id}` : ''}`;
  const text = (el) => (el.textContent || '').trim();
  const isHidden = (el) => { for (let p = el; p; p = p.parentElement) if (p.hasAttribute && (p.hasAttribute('hidden') || attr(p, 'aria-hidden') === 'true')) return true; return false; };

  // Labels: every visible control needs a label[for], aria-label, aria-labelledby, title, or to sit in a label.
  const labelFor = new Set(all('label').map((l) => attr(l, 'for')).filter(Boolean));
  const insideLabel = (el) => { for (let p = el.parentElement; p; p = p.parentElement) if (String(p.tagName).toLowerCase() === 'label') return true; return false; };
  for (const el of all('input, select, textarea')) {
    const type = attr(el, 'type').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type) || isHidden(el)) continue;
    const labelled = (el.id && labelFor.has(el.id)) || attr(el, 'aria-label') || attr(el, 'aria-labelledby') || attr(el, 'title') || insideLabel(el);
    if (!labelled) warn('label', name(el), 'form control has no accessible label');
  }
  for (const el of all('button, a[href]')) {
    if (isHidden(el)) continue;
    const label = text(el) || attr(el, 'aria-label') || attr(el, 'aria-labelledby') || attr(el, 'title');
    if (!label && !(el.querySelector && el.querySelector('img[alt]:not([alt=""])'))) warn('name', name(el), `${String(el.tagName).toLowerCase()} has no accessible name`);
  }

  // Images need an alt attribute (empty alt is valid for decorative images).
  for (const el of all('img')) {
    if (!el.hasAttribute('alt')) warn('alt', name(el) || 'img', 'image has no alt attribute');
  }

  // Landmarks and headings.
  if (all('main, [role="main"]').length !== 1) warn('landmark', 'main', `expected exactly one main landmark, found ${all('main, [role="main"]').length}`);
  if (!all('header, [role="banner"]').length) warn('landmark', 'header', 'no banner (header) landmark');
  if (all('h1').length < 1) warn('heading', 'h1', 'page has no h1');
  const doc = root.documentElement || root.ownerDocument?.documentElement;
  if (doc && !attr(doc, 'lang')) warn('lang', 'html', 'html element has no lang attribute');
  const ids = new Map();
  for (const el of all('[id]')) ids.set(el.id, (ids.get(el.id) || 0) + 1);
  for (const [id, n] of ids) if (n > 1) warn('duplicate-id', `#${id}`, `id is used ${n} times`);

  // Computed-style contrast (browser only).
  const view = root.ownerDocument?.defaultView || root.defaultView;
  if (opts.contrast !== false && view && typeof view.getComputedStyle === 'function') {
    const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = (c) => { const [r, g, b] = [c.r, c.g, c.b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const backdrop = (el) => { for (let p = el; p; p = p.parentElement) { const c = parse(view.getComputedStyle(p).backgroundColor); if (c && c.a > 0.95) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
    let seen = 0;
    const limit = opts.maxContrastNodes || 500;
    for (const el of all('body *')) {
      if (seen >= limit) break;
      const direct = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim());
      if (!direct) continue;
      const cs = view.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const fg = parse(cs.color); if (!fg) continue;
      seen += 1;
      const bg = backdrop(el);
      const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const size = parseFloat(cs.fontSize) || 16;
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      const min = large ? 3 : 4.5;
      if (ratio < min) warn('contrast', name(el), `text contrast ${ratio.toFixed(2)}:1 is below ${min}:1 (${cs.color} on rgb(${bg.r}, ${bg.g}, ${bg.b}))`);
    }
  }
  return out;
}

/**
 * Report findings as warnings only. Never throws and never fails a test.
 * @param {{rule:string,target:string,message:string}[]} findings
 * @param {{ label?: string, diagnostic?: (m:string)=>void, warn?: (m:string)=>void }} [sinks]
 * @returns {string[]} the lines reported
 */
export function reportWarnings(findings, { label = 'a11y', diagnostic, warn = console.warn } = {}) {
  const lines = (findings || []).map((f) => `[${label}] warning ${f.rule} ${f.target}: ${f.message}`);
  if (!lines.length) lines.push(`[${label}] no accessibility warnings`);
  for (const l of lines) {
    try { diagnostic?.(l); } catch { /* reporting must not fail */ }
    try { if (findings?.length) warn(l); } catch { /* reporting must not fail */ }
  }
  return lines;
}
