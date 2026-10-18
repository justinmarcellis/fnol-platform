import net from 'node:net';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

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
    // SIIT ::ffff:0:a.b.c.d (::ffff:0:0/96): translated IPv4, classify the embedded address (never public-by-default).
    if (h.slice(0, 4).every((n) => n === 0) && h[4] === 0xffff && h[5] === 0) return embedded(h[6], h[7]) === 'public' ? 'private' : embedded(h[6], h[7]);
    // 64:ff9b:1::/48 NAT64 local-use: routable inside a site only.
    if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return 'private';
    if (h[0] === 0x2002) return 'private'; // 6to4 2002::/16 embeds an IPv4 gateway
    if (h[0] === 0x2001 && h[1] === 0) return 'private'; // Teredo 2001::/32
    if ((h[0] & 0xffc0) === 0xfec0) return 'private'; // fec0::/10 site local (deprecated)
    if ((h[0] & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
    if ((h[0] & 0xffc0) === 0xfe80) return 'private'; // fe80::/10 link local
    if ((h[0] & 0xff00) === 0xff00) return 'private'; // multicast
    // Only global unicast 2000::/3 is public, minus documentation ranges 2001:db8::/32 and 3fff::/20.
    if ((h[0] & 0xe000) !== 0x2000) return 'private';
    if (h[0] === 0x2001 && h[1] === 0x0db8) return 'private';
    if (h[0] === 0x3fff && h[1] < 0x1000) return 'private';
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
 * Kept for callers that only need a verdict; delivery uses {@link resolveAndPin}, which also pins the connection.
 * @param {URL} url
 * @param {(host: string) => Promise<string[]>} [resolveHost]
 * @returns {Promise<string|null>} reason when blocked, otherwise null
 */
export async function checkResolvedHost(url, resolveHost = defaultResolve) {
  const r = await resolveAndPin(url, { resolveHost });
  return r.ok ? null : r.reason;
}

async function defaultResolve(host) {
  return (await dns.lookup(host, { all: true })).map((a) => a.address);
}

/**
 * Resolve a target host exactly once, classify EVERY returned address and pick one to connect to.
 * Mixed answers (any private/loopback/invalid) are rejected. Literal IPs are validated and pinned as-is.
 * With `allowLoopback` (devMode loopback targets) loopback answers are accepted, but still only loopback ones.
 * The caller must connect to `address` (not the hostname) so no second DNS answer is ever used.
 * @param {URL} url
 * @param {{ resolveHost?: (host: string) => Promise<string[]>, allowLoopback?: boolean }} [opts]
 * @returns {Promise<{ ok: true, address: string, family: 4|6, hostname: string, addresses: string[] } | { ok: false, reason: string }>}
 */
export async function resolveAndPin(url, { resolveHost = defaultResolve, allowLoopback = false } = {}) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(hostname)) addrs = [hostname];
  else {
    try { addrs = await resolveHost(hostname); } catch { return { ok: false, reason: 'host could not be resolved' }; }
  }
  if (!Array.isArray(addrs) || !addrs.length) return { ok: false, reason: 'host could not be resolved' };
  for (const a of addrs) {
    const c = classifyAddress(String(a));
    if (allowLoopback ? c === 'loopback' : c === 'public') continue;
    return { ok: false, reason: 'host resolves to a private address' };
  }
  const address = String(addrs[0]).replace(/^\[|\]$/g, '');
  return { ok: true, address, family: net.isIP(address), hostname, addresses: addrs.map(String) };
}

/**
 * Tenant allowedHosts check (TenantConfig notifications.webhooks.allowedHosts, SEC2-015).
 * Entries are exact hostnames or "*.example.com" (any subdomain, not the apex). Case-insensitive.
 * An empty or missing list denies every host unless `devMode`; devMode also lets loopback targets through a non-empty list.
 * @param {string} hostname
 * @param {string[]|undefined} allowedHosts
 * @param {{ devMode?: boolean, loopback?: boolean }} [opts]
 * @returns {string|null} reason when refused, otherwise null
 */
export function checkAllowedHost(hostname, allowedHosts, { devMode = false, loopback = false } = {}) {
  const list = Array.isArray(allowedHosts) ? allowedHosts.filter((h) => typeof h === 'string' && h.trim()) : [];
  if (devMode && (loopback || !list.length)) return null;
  if (!list.length) return 'no allowed webhook hosts are configured for this tenant';
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  const ok = list.some((raw) => {
    const e = raw.trim().toLowerCase().replace(/\.$/, '');
    return e.startsWith('*.') ? host.endsWith(e.slice(1)) && host.length > e.length - 1 : host === e;
  });
  return ok ? null : 'host is not in the tenant allowedHosts list';
}

/**
 * Send one request to a pinned address with node:http(s) (no new dependencies). TLS verifies the certificate against
 * the ORIGINAL hostname (servername) and the Host header carries it. Never follows redirects: a 3xx is returned as is.
 * The response body is read up to `maxBytes` and then dropped.
 * @param {{ url: URL, address: string, family?: 4|6, method?: string, headers?: object, body?: string, timeoutMs?: number, maxBytes?: number, signal?: AbortSignal }} req
 * @returns {Promise<{ status: number, headers: object, body: Buffer }>}
 */
export function pinnedRequest({ url, address, family, method = 'POST', headers = {}, body, timeoutMs = 5000, maxBytes = 1024 * 1024, signal }) {
  const secure = url.protocol === 'https:';
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const opts = {
      host: address, family: family ?? net.isIP(address), port: url.port || (secure ? 443 : 80), method,
      path: `${url.pathname}${url.search}`, headers: { ...headers, Host: url.host }, signal, timeout: timeoutMs, agent: false,
    };
    if (secure) opts.servername = net.isIP(hostname) ? undefined : hostname;
    const req = (secure ? https : http).request(opts, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { if (size < maxBytes) { chunks.push(c); size += c.length; } });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => { const e = new Error('timeout'); e.name = 'AbortError'; req.destroy(e); });
    req.on('error', reject);
    req.end(body);
  });
}
