/**
 * Remote mode for the demo-script e2e (S5-QE-01, IMP-11).
 *
 * FNOL_BASE_URL   run the beats against that deployed service instead of an in-process app
 * FNOL_IAP_TOKEN  optional; sent as Proxy-Authorization: Bearer <token> on every request so an
 *                 identity-aware proxy can authenticate the caller while the app's own
 *                 Authorization header carries the app token
 *
 * Nothing here ever prints the IAP token, an app token or a response body.
 */

/** @returns {{baseUrl:string, iapToken:string|null}|null} null when FNOL_BASE_URL is unset (local mode). */
export function remoteConfig(env = process.env) {
  const raw = (env.FNOL_BASE_URL ?? '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { throw new Error('FNOL_BASE_URL is not a valid URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('FNOL_BASE_URL must be an http(s) URL');
  const iap = (env.FNOL_IAP_TOKEN ?? '').trim();
  return { baseUrl: url.origin + url.pathname.replace(/\/+$/, ''), iapToken: iap || null };
}

/** Headers added to every remote request (IAP credential only; the app token goes in Authorization). */
export function remoteHeaders(cfg) {
  return cfg?.iapToken ? { 'proxy-authorization': `Bearer ${cfg.iapToken}` } : {};
}

/** Tracks the last HTTP status per beat so a failure can name status and beat only. */
export function createFailureReporter() {
  let lastStatus = null;
  return {
    record(status) { lastStatus = status; },
    /** Run a beat body; on any error throw a sanitised one: beat name and last status, no messages or bodies. */
    async guard(beatName, fn) {
      try {
        return await fn();
      } catch (err) {
        if (err?.name === 'NotImplemented') throw err;
        const e = new Error(`remote beat failed: ${beatName} (last HTTP status ${lastStatus ?? 'none'}, ${err?.name ?? 'Error'})`);
        e.stack = e.message;
        throw e;
      }
    },
  };
}
