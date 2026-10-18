// Loss date handling in the tenant time zone.

const pad = (n) => String(n).padStart(2, '0');

/** Offset (ms) of a zone at a UTC instant. */
function zoneOffsetMs(timeZone, instantMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(instantMs / 1000) * 1000;
}

/** Calendar date (YYYY-MM-DD) of a UTC instant in a zone. */
export function dateInZone(instantMs, timeZone) {
  const d = new Date(instantMs + zoneOffsetMs(timeZone, instantMs));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** UTC instant (ms) of a wall-clock date and time in a zone. */
function instantOf(date, time, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - zoneOffsetMs(timeZone, guess);
  return guess - zoneOffsetMs(timeZone, first);
}

/**
 * Loss date as a calendar date in the tenant time zone.
 * A full timestamp is converted to the tenant zone. A date with a lossTime recorded in a
 * different zone is re-expressed in the tenant zone. A bare date is used as given.
 * @param {{ lossDate: string, lossTime?: string, lossTimeZone?: string }} loss
 * @param {string} tenantZone IANA zone
 */
export function lossDateInTenantZone(loss, tenantZone) {
  const zone = tenantZone || 'America/Chicago';
  const raw = String(loss.lossDate ?? '');
  try {
    if (raw.includes('T')) return dateInZone(Date.parse(raw), zone);
    if (loss.lossTime && loss.lossTimeZone && loss.lossTimeZone !== zone) {
      return dateInZone(instantOf(raw, loss.lossTime, loss.lossTimeZone), zone);
    }
  } catch { /* unknown zone: fall back to the bare date */ }
  return raw.slice(0, 10);
}
