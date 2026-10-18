// Error helpers shared by the pure CSR modules. No kit imports.

/**
 * True when an error means the backend (or a route) is not reachable.
 * 404 with an error envelope (for example "policy not found") is NOT unavailable.
 * @param {any} err
 */
export function isUnavailable(err) {
  if (!err) return false;
  if (err.code === 'service_unavailable') return true;
  if (typeof err.status === 'number') return err.status === 0 || err.status >= 500 || (err.status === 404 && err.code === 'route_not_found');
  return true; // thrown without a status: network failure
}

/** Resolve an I18nText (string or locale map). */
export function resolveI18n(v, locale = 'en') {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return v[locale] ?? v.en ?? Object.values(v)[0] ?? '';
}

/** Today as YYYY-MM-DD from an injected clock ({now():number}). */
export function isoDate(clock = { now: () => Date.now() }) {
  return new Date(clock.now()).toISOString().slice(0, 10);
}
