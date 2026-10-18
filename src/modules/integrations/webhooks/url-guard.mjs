import net from 'node:net';
import dns from 'node:dns/promises';

/** Expand an IPv6 literal into 8 numeric hextets, or null if malformed. */
function expandIPv6(addr) {
  let s = addr.toLowerCase().split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array(fill).fill('0'), ...tail].map((h) => parseInt(h, 16));
  return parts.length === 8 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? parts : null;
}

function classifyV4(o) {
  const [a, b] = o;
  if (a === 127) return 'loopback';
  if (a === 0 || a === 10 || a >= 224) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 169 && b === 254) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 192 && b === 0 && o[2] === 0) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'private';
  return 'public';
}

/**
 * Classify an IP literal.
 * @param {string} ip
 * @returns {'loopback'|'private'|'public'|'invalid'}
 */
export function classifyAddress(ip) {
  const bare = ip.replace(/^\[|\]$/g, '');
  const kind = net.isIP(bare);
  if (kind === 4) return classifyV4(bare.split('.').map(Number));
  if (kind === 6) {
    const h = expandIPv6(bare);
    if (!h) return 'invalid';
    if (h.every((n, i) => n === 0 || (i === 7 && n === 1)) ) return h[7] === 1 ? 'loopback' : 'private';
    const embedded = (hi, lo) => classifyV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::/96 (NAT64)
    if (h.slice(0, 5).every((n) => n === 0) && h[5] === 0xffff) return embedded(h[6], h[7]);
    if (h.slice(0, 6).every((n) => n === 0)) return embedded(h[6], h[7]);
    if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((n) => n === 0)) return embedded(h[6], h[7]);
    if ((h[0] & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
    if ((h[0] & 0xffc0) === 0xfe80) return 'private'; // fe80::/10 link local
    if ((h[0] & 0xff00) === 0xff00) return 'private'; // multicast
    return 'public';
  }
  return 'invalid';
}

/** True for an IP literal in a loopback, private, link-local or reserved range. */
export function isPrivateAddress(ip) {
  const c = classifyAddress(ip);
  return c === 'loopback' || c === 'private' || c === 'invalid';
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.intranet', '.corp', '.home'];

function hostKind(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
  if (net.isIP(h.replace(/^\[|\]$/g, ''))) return classifyAddress(h);
  if (!h.includes('.') || INTERNAL_SUFFIXES.some((s) => h.endsWith(s))) return 'private';
  return 'public';
}

/**
 * Synchronous SSRF-safe validation of a webhook target URL.
 * Production: https only, no credentials, no loopback/private/link-local/internal hosts.
 * Dev/test (`devMode`): additionally allows loopback hosts (http or https) for local receivers.
 * @param {string} raw
 * @param {{ devMode?: boolean }} [opts]
 * @returns {{ ok: boolean, reason?: string, url?: URL, loopback?: boolean }}
 */
export function validateWebhookUrl(raw, { devMode = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return { ok: false, reason: 'url must be a non-empty string up to 2048 characters' };
  let url;
  try { url = new URL(raw.trim()); } catch { return { ok: false, reason: 'url is not a valid absolute URL' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'url must use https' };
  if (url.username || url.password) return { ok: false, reason: 'url must not contain credentials' };
  const kind = hostKind(url.hostname);
  if (kind === 'invalid') return { ok: false, reason: 'url host is not valid' };
  if (kind === 'loopback') {
    if (!devMode) return { ok: false, reason: 'url host is not allowed (loopback)' };
    return { ok: true, url, loopback: true };
  }
  if (kind === 'private') return { ok: false, reason: 'url host is not allowed (private or internal address)' };
  if (url.protocol !== 'https:') return { ok: false, reason: 'url must use https' };
  return { ok: true, url, loopback: false };
}

/**
 * Delivery-time check: resolve the hostname and refuse private answers (DNS rebinding defence).
 * Literal IPs and dev loopback targets are skipped. Note: fetch resolves again, so a narrow race remains;
 * run the worker behind an egress proxy in production for a hard guarantee.
 * @param {URL} url
 * @param {(host: string) => Promise<string[]>} [resolveHost]
 * @returns {Promise<string|null>} reason when blocked, otherwise null
 */
export async function checkResolvedHost(url, resolveHost = defaultResolve) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return null;
  let addrs;
  try { addrs = await resolveHost(host); } catch { return 'host could not be resolved'; }
  if (!addrs.length) return 'host could not be resolved';
  if (addrs.some(isPrivateAddress)) return 'host resolves to a private address';
  return null;
}

async function defaultResolve(host) {
  return (await dns.lookup(host, { all: true })).map((a) => a.address);
}
