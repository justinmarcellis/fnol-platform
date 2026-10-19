// Tiny i18n. Kit owns common.* and kit.*; apps register claimant.*, csr.*, etc.

const tables = { en: {}, es: {} };
let locale = 'en';
const listeners = new Set();

export const supportedLocales = ['en', 'es'];

tables.en = {
  'common.submit': 'Submit',
  'common.cancel': 'Cancel',
  'common.next': 'Next',
  'common.back': 'Back',
  'common.save': 'Save',
  'common.close': 'Close',
  'common.loading': 'Loading',
  'common.required': 'required',
  'common.optional': 'optional',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.error': 'Something went wrong. Please try again.',
  'common.serviceUnavailable': 'The service is temporarily unavailable. Please try again shortly.',
  'common.language': 'Language',
  'common.theme': 'Theme',
  'kit.field.required': '{label} is required.',
  'kit.field.invalid': '{label} is not valid.',
  'kit.field.minLength': '{label} must be at least {min} characters.',
  'kit.field.maxLength': '{label} must be at most {max} characters.',
  'kit.stepper.stepOf': 'Step {current} of {total}',
  'kit.stepper.complete': 'completed',
  'kit.stepper.current': 'current step',
  'kit.upload.drop': 'Choose files or drop them here',
  'kit.upload.remove': 'Remove {name}',
  'kit.upload.tooLarge': '{name} is larger than {max} MB.',
  'kit.upload.badType': '{name} is not an accepted file type.',
  'kit.upload.tooMany': 'You can add at most {max} files.',
  'kit.upload.preview': 'Preview of {name}',
  'kit.chat.send': 'Send',
  'kit.chat.placeholder': 'Type your message',
  'kit.chat.log': 'Conversation',
  'kit.chat.you': 'You',
  'kit.chat.assistant': 'Assistant',
  'kit.chat.typing': 'Assistant is typing',
  'kit.timeline.label': 'Activity timeline',
  'kit.timeline.empty': 'No activity yet.',
  'kit.toast.dismiss': 'Dismiss notification',
  'kit.table.empty': 'No results.',
  'kit.table.sortedAsc': 'sorted ascending',
  'kit.table.sortedDesc': 'sorted descending',
  'kit.table.sortBy': 'Sort by {column}',
  'kit.table.rowCount': '{count} rows',
};
tables.es = {
  'common.submit': 'Enviar',
  'common.cancel': 'Cancelar',
  'common.next': 'Siguiente',
  'common.back': 'Atrás',
  'common.save': 'Guardar',
  'common.close': 'Cerrar',
  'common.loading': 'Cargando',
  'common.required': 'obligatorio',
  'common.optional': 'opcional',
  'common.yes': 'Sí',
  'common.no': 'No',
  'common.error': 'Algo salió mal. Inténtelo de nuevo.',
  'common.serviceUnavailable': 'El servicio no está disponible temporalmente. Inténtelo de nuevo en breve.',
  'common.language': 'Idioma',
  'common.theme': 'Tema',
  'kit.field.required': '{label} es obligatorio.',
  'kit.field.invalid': '{label} no es válido.',
  'kit.field.minLength': '{label} debe tener al menos {min} caracteres.',
  'kit.field.maxLength': '{label} debe tener como máximo {max} caracteres.',
  'kit.stepper.stepOf': 'Paso {current} de {total}',
  'kit.stepper.complete': 'completado',
  'kit.stepper.current': 'paso actual',
  'kit.upload.drop': 'Elija archivos o suéltelos aquí',
  'kit.upload.remove': 'Quitar {name}',
  'kit.upload.tooLarge': '{name} supera los {max} MB.',
  'kit.upload.badType': '{name} no es un tipo de archivo aceptado.',
  'kit.upload.tooMany': 'Puede agregar como máximo {max} archivos.',
  'kit.upload.preview': 'Vista previa de {name}',
  'kit.chat.send': 'Enviar',
  'kit.chat.placeholder': 'Escriba su mensaje',
  'kit.chat.log': 'Conversación',
  'kit.chat.you': 'Usted',
  'kit.chat.assistant': 'Asistente',
  'kit.chat.typing': 'El asistente está escribiendo',
  'kit.timeline.label': 'Cronología de actividad',
  'kit.timeline.empty': 'Aún no hay actividad.',
  'kit.toast.dismiss': 'Descartar notificación',
  'kit.table.empty': 'Sin resultados.',
  'kit.table.sortedAsc': 'orden ascendente',
  'kit.table.sortedDesc': 'orden descendente',
  'kit.table.sortBy': 'Ordenar por {column}',
  'kit.table.rowCount': '{count} filas',
};

/** Return a copy of the built-in kit tables (used by the parity test). */
export function kitTables() {
  return { en: { ...tables.en }, es: { ...tables.es } };
}

/** Merge strings for a locale. Unknown locales are created. */
export function registerStrings(loc, table) {
  tables[loc] = { ...(tables[loc] ?? {}), ...table };
  if (!supportedLocales.includes(loc)) supportedLocales.push(loc);
}

export function getLocale() { return locale; }

/** Set the active locale (falls back to its base language, then en). Returns the active locale. */
export function setLocale(loc) {
  const base = String(loc ?? 'en').toLowerCase().split('-')[0];
  locale = supportedLocales.includes(base) ? base : 'en';
  try { if (typeof document !== 'undefined') document.documentElement.lang = locale; } catch { /* no DOM */ }
  for (const fn of listeners) fn(locale);
  return locale;
}

/** Subscribe to locale changes. Returns an unsubscribe function. */
export function onLocaleChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Translate. Falls back to en, then to the key. `{name}` placeholders are interpolated. */
export function t(key, params = {}) {
  const s = tables[locale]?.[key] ?? tables.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
}

/** Resolve an I18nText (string or locale map) per contract. */
export function resolveText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return v[locale] ?? v.en ?? Object.values(v)[0] ?? '';
}
