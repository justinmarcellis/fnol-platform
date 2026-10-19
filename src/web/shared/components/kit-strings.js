// Strings for the v2 components (shell, badge, stat, skeleton, empty state). Kept here, not in i18n.js,
// so the kit's i18n tables stay owned by their file; follows the active i18n locale (en, es).
import { getLocale } from '../i18n.js';

const S = {
  en: {
    'shell.openNav': 'Open navigation',
    'shell.closeNav': 'Close navigation',
    'shell.primaryNav': 'Primary',
    'shell.userMenu': 'Account menu for {name}',
    'shell.signedInAs': 'Signed in as',
    'shell.tenant': 'Organization',
    'shell.signOut': 'Sign out',
    'shell.demo': 'Demo controls',
    'skeleton.loading': 'Loading',
    'stat.up': 'up',
    'stat.down': 'down',
    'stat.flat': 'no change',
    'stat.vs': 'vs {period}',
    'toast.success': 'Success',
    'toast.error': 'Error',
    'toast.warning': 'Warning',
    'toast.info': 'Notice',
  },
  es: {
    'shell.openNav': 'Abrir navegación',
    'shell.closeNav': 'Cerrar navegación',
    'shell.primaryNav': 'Principal',
    'shell.userMenu': 'Menú de cuenta de {name}',
    'shell.signedInAs': 'Sesión iniciada como',
    'shell.tenant': 'Organización',
    'shell.signOut': 'Cerrar sesión',
    'shell.demo': 'Controles de demostración',
    'skeleton.loading': 'Cargando',
    'stat.up': 'sube',
    'stat.down': 'baja',
    'stat.flat': 'sin cambios',
    'stat.vs': 'frente a {period}',
    'toast.success': 'Correcto',
    'toast.error': 'Error',
    'toast.warning': 'Aviso',
    'toast.info': 'Información',
  },
};

/** Translate a v2 component string for the active locale (falls back to en, then the key). */
export function kt(key, params = {}) {
  let loc = 'en';
  try { loc = getLocale(); } catch { /* default */ }
  const s = S[loc]?.[key] ?? S.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
}

/** Copy of the tables (parity test). */
export function kitStringTables() { return { en: { ...S.en }, es: { ...S.es } }; }
