// Inline SVG icon set. Original drawings on a 24 px grid, 1.75 px round stroke, currentColor.
// No icon font, no CDN. Use icon() for markup strings and createIcon() for DOM nodes.

/** Inner SVG markup per icon name. Constant strings only; never interpolate user input here. */
export const ICONS = {
  home: '<path d="M4 10.5 12 4l8 6.5"/><path d="M6 9v10h4.5v-5h3v5H18V9"/>',
  inbox: '<path d="M4 13.5 6.5 5h11l2.5 8.5"/><path d="M4 13.5V19h16v-5.5h-4.5l-1.5 2.5h-4l-1.5-2.5z"/>',
  claim: '<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4"/><path d="M9.5 12h6M9.5 15.5h6"/>',
  file: '<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m15.5 15.5 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  'chevron-down': '<path d="m6 9.5 6 6 6-6"/>',
  'chevron-up': '<path d="m6 14.5 6-6 6 6"/>',
  'chevron-right': '<path d="m9.5 6 6 6-6 6"/>',
  'chevron-left': '<path d="m14.5 6-6 6 6 6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  'arrow-up': '<path d="M12 19V5M6 11l6-6 6 6"/>',
  'arrow-down': '<path d="M12 5v14M6 13l6 6 6-6"/>',
  'trend-up': '<path d="M4 17l5.5-5.5 3.5 3.5L20 8"/><path d="M15 8h5v5"/>',
  'trend-down': '<path d="M4 7l5.5 5.5 3.5-3.5L20 16"/><path d="M15 16h5v-5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  more: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c.8-3.4 3.6-5.5 7-5.5s6.2 2.1 7 5.5"/>',
  users: '<circle cx="9" cy="9" r="3"/><path d="M3.5 18.5c.6-2.8 2.8-4.5 5.5-4.5s4.9 1.7 5.5 4.5"/><path d="M15 6.2a3 3 0 0 1 0 5.6M17 14.3c1.8.6 3 2 3.5 4.2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z"/><path d="M10 20.5h4"/>',
  'alert-triangle': '<path d="M12 4 3 19.5h18z"/><path d="M12 10v4.5"/><circle cx="12" cy="17" r=".6"/>',
  'alert-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16" r=".6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="8" r=".6"/>',
  'check-circle': '<circle cx="12" cy="12" r="8.5"/><path d="m8 12.5 3 3 5-6"/>',
  'x-circle': '<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6M15 9l-6 6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  car: '<path d="M5 15.5V12l1.8-4.2A2 2 0 0 1 8.6 6.5h6.8a2 2 0 0 1 1.8 1.3L19 12v3.5"/><path d="M4 12h16v4.5H4z"/><circle cx="7.5" cy="16.5" r="1.6"/><circle cx="16.5" cy="16.5" r="1.6"/>',
  house: '<path d="M4 11 12 4.5 20 11"/><path d="M6 9.5v10h12v-10"/><path d="M10 19.5v-5h4v5"/>',
  water: '<path d="M12 4c3 3.6 5.5 6.6 5.5 9.5a5.5 5.5 0 0 1-11 0C6.5 10.6 9 7.6 12 4z"/>',
  shield: '<path d="M12 3.5 19 6v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z"/>',
  'shield-check': '<path d="M12 3.5 19 6v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  upload: '<path d="M12 15V4.5M7.5 9 12 4.5 16.5 9"/><path d="M4.5 15v4.5h15V15"/>',
  download: '<path d="M12 4.5V15M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 15v4.5h15V15"/>',
  paperclip: '<path d="M19 11.5 12.2 18.3a4.2 4.2 0 0 1-6-6l7.1-7.1a2.8 2.8 0 0 1 4 4l-7 7a1.4 1.4 0 0 1-2-2l6.3-6.3"/>',
  camera: '<path d="M4 8h3.5L9 5.5h6L16.5 8H20v11H4z"/><circle cx="12" cy="13.5" r="3.2"/>',
  phone: '<path d="M6.5 4h3l1.5 4-2 1.3a10 10 0 0 0 5.7 5.7l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A16 16 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
  chat: '<path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3.5v-3.5H6.5a2 2 0 0 1-2-2z"/>',
  external: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M17 14v5.5H4.5V7H10"/>',
  filter: '<path d="M4 5.5h16l-6.2 7.3V19l-3.6-1.8v-4.4z"/>',
  logout: '<path d="M14.5 4.5h-8v15h8"/><path d="M10.5 12h10M17 8.5l3.5 3.5-3.5 3.5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.5H15"/>',
  sparkles: '<path d="M10 4.5 11.5 9 16 10.5 11.5 12 10 16.5 8.5 12 4 10.5 8.5 9z"/><path d="M17.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  pin: '<path d="M12 20.5s6-5.6 6-10.5a6 6 0 0 0-12 0c0 4.9 6 10.5 6 10.5z"/><circle cx="12" cy="10" r="2.2"/>',
  dollar: '<path d="M12 3.5v17"/><path d="M16 7.5c-.6-1.3-2.1-2-4-2-2.3 0-4 1.1-4 3s1.7 2.6 4 3.2 4 1.3 4 3.3-1.7 3-4 3c-2 0-3.5-.8-4.2-2.2"/>',
  gauge: '<path d="M4.5 17a8 8 0 1 1 15 0"/><path d="m12 13.5 3.5-4"/><circle cx="12" cy="14" r="1.2"/>',
  layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/><path d="m3.5 16.5 8.5 4.5 8.5-4.5"/>',
  building: '<path d="M5 20.5V5.5h9v15"/><path d="M14 10h5v10.5"/><path d="M3.5 20.5h17M8 8.5h3M8 12h3M8 15.5h3"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  edit: '<path d="M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10z"/><path d="m13 7 4 4"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7"/><path d="M6.5 7l1 12.5h9l1-12.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>',
  flag: '<path d="M5.5 20.5V4.5"/><path d="M5.5 5h11l-2 4 2 4h-11"/>',
  list: '<path d="M9 7h11M9 12h11M9 17h11"/><circle cx="5" cy="7" r=".8"/><circle cx="5" cy="12" r=".8"/><circle cx="5" cy="17" r=".8"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  activity: '<path d="M3.5 12h4l2.5-6.5 4 13 2.5-6.5h4"/>',
  briefcase: '<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V5.5h6v2M3.5 12.5h17"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="m10.5 12.5 8-8M16 7l2.5 2.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
};

/** Icon names available. */
export const iconNames = Object.keys(ICONS);

/**
 * SVG markup for an icon. Decorative (aria-hidden) unless `label` is given, in which case it gets role=img and a <title>.
 * @param {string} name icon name from ICONS (unknown names render an empty 24 px box)
 * @param {{size?:number, label?:string, className?:string, strokeWidth?:number}} [opts]
 * @returns {string}
 */
export function icon(name, { size = 20, label, className = 'fx-icon', strokeWidth = 1.75 } = {}) {
  const body = ICONS[name] ?? '';
  const s = Number(size) || 20;
  const sw = Number(strokeWidth) || 1.75;
  const cls = String(className).replace(/[^\w -]/g, '');
  const a11y = label ? `role="img" aria-label="${escapeAttr(label)}"` : 'aria-hidden="true" focusable="false"';
  const title = label ? `<title>${escapeText(label)}</title>` : '';
  return `<svg class="${cls}" ${a11y} xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" data-icon="${escapeAttr(name)}">${title}${body}</svg>`;
}

/**
 * Create an icon element in `doc` (default: global document). Returns null without a DOM.
 * @param {string} name
 * @param {{size?:number, label?:string, className?:string, strokeWidth?:number, doc?:Document}} [opts]
 */
export function createIcon(name, opts = {}) {
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;
  const tpl = doc.createElement('template');
  tpl.innerHTML = icon(name, opts); // constant markup from ICONS; label/name are escaped
  return tpl.content.firstElementChild;
}

function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
