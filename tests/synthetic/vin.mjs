/** VIN generation and check-digit validation (ISO 3779 / 49 CFR 565). Fictional WMIs. */

const TRANSLIT = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const WMIS = ['1FZ', '1GZ', '2HZ', '3VZ', '4TZ', '5YZ'];

function value(ch) {
  return /[0-9]/.test(ch) ? Number(ch) : TRANSLIT[ch];
}

/** Compute the check digit (0-9 or X) for a 17-char VIN (position 9 is ignored). */
export function computeCheckDigit(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += value(vin[i]) * WEIGHTS[i];
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

/** True when vin is 17 valid chars (no I, O, Q) with a correct check digit. */
export function isValidVin(vin) {
  return typeof vin === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) && vin[8] === computeCheckDigit(vin);
}

/** Generate a valid VIN for a model year. */
export function generateVin(rng, modelYear = 2022) {
  const yearCode = YEAR_CODES[(modelYear - 2010) % YEAR_CODES.length];
  const chars = rng.pick(WMIS) + rng.alnum(5, VIN_CHARS) + '0' + yearCode + rng.alnum(1, VIN_CHARS) + rng.alnum(6, '0123456789');
  return chars.slice(0, 8) + computeCheckDigit(chars) + chars.slice(9);
}
