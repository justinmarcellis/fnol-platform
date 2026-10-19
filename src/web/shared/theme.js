// Theme helpers: brand tokens from public config, light/dark scheme.

export const HEX = /^#[0-9a-fA-F]{6}$/;

function lum(hex) {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio of two #rrggbb colors. */
export function contrastRatio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Pick white or near-black text for a background, whichever contrasts more. */
export function readableOn(bg) {
  return contrastRatio(bg, '#ffffff') >= contrastRatio(bg, '#111111') ? '#ffffff' : '#111111';
}

const SAFE_FONT = /^[A-Za-z0-9 ,'"._-]{1,200}$/;
const SAFE_LOGO = /^(\/|\.\/)?[A-Za-z0-9._\/-]+$/;

/**
 * Map public-config branding to CSS custom properties. Pure.
 * Non-hex colors, unsafe fonts and non-relative logo paths are rejected (omitted) and reported.
 * @returns {{vars:Record<string,string>, rejected:string[]}}
 */
export function brandingToTokens(branding = {}) {
  const vars = {};
  const rejected = [];
  const color = (key, name, onName) => {
    const v = branding?.[key];
    if (v === undefined) return;
    if (typeof v === 'string' && HEX.test(v)) {
      vars[name] = v.toLowerCase();
      if (onName) vars[onName] = readableOn(v);
    } else rejected.push(key);
  };
  color('primaryColor', '--fx-brand', '--fx-on-brand');
  color('accentColor', '--fx-accent', '--fx-on-accent');
  if (branding?.fontFamily !== undefined) {
    if (typeof branding.fontFamily === 'string' && SAFE_FONT.test(branding.fontFamily)) vars['--fx-font'] = `${branding.fontFamily}, system-ui, sans-serif`;
    else rejected.push('fontFamily');
  }
  if (branding?.logoUrl !== undefined) {
    if (typeof branding.logoUrl === 'string' && SAFE_LOGO.test(branding.logoUrl) && !branding.logoUrl.includes('..') && !branding.logoUrl.startsWith('//')) vars['--fx-logo-url'] = `url("${branding.logoUrl}")`;
    else rejected.push('logoUrl');
  }
  return { vars, rejected };
}

/**
 * Apply public-config branding to a root element (default documentElement).
 * Accepts the full public config or just the branding object.
 */
export function applyBranding(config, root) {
  const branding = config?.branding ?? config ?? {};
  const result = brandingToTokens(branding);
  const el = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (el?.style) for (const [k, v] of Object.entries(result.vars)) el.style.setProperty(k, v);
  return result;
}

/** Set the color scheme: 'light' | 'dark' | 'auto'. Returns the stored value. */
export function setScheme(scheme, root) {
  const s = ['light', 'dark'].includes(scheme) ? scheme : 'auto';
  const el = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (el) {
    if (s === 'auto') el.removeAttribute?.('data-theme');
    else el.setAttribute?.('data-theme', s);
  }
  return s;
}
