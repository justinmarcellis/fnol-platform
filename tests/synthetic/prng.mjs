/** Seeded PRNG helpers (mulberry32). No Math.random, no Date.now. */

/**
 * Hash any string/number seed to a 32-bit unsigned int (FNV-1a).
 * @param {string|number} seed
 * @returns {number}
 */
export function hashSeed(seed) {
  const s = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Create a deterministic random source.
 * @param {string|number} seed
 */
export function createRng(seed) {
  let a = hashSeed(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const pick = (arr) => arr[Math.floor(next() * arr.length)];
  const chance = (p) => next() < p;
  const alnum = (n, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789') => {
    let out = '';
    for (let i = 0; i < n; i += 1) out += alphabet[Math.floor(next() * alphabet.length)];
    return out;
  };
  /** Derive an independent child generator. */
  const fork = (label) => createRng(`${hashSeed(seed)}:${label}`);
  return { next, int, pick, chance, alnum, fork };
}

/** Add days to an ISO date (YYYY-MM-DD), pure UTC arithmetic. */
export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Add whole years to an ISO date. */
export function addYears(iso, years) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
}
