import { pinnedRequest } from '../webhooks/url-guard.mjs';
import { mapProfileA } from './profiles/profile-a.mjs';
import { mapProfileB } from './profiles/profile-b.mjs';

const MAPPERS = { A: mapProfileA, B: mapProfileB };

/**
 * The sample, vendor-neutral claims-port adapter. Profile A emits nested camelCase ACORD aggregates;
 * profile B emits a flat UPPER_SNAKE record with YYYYMMDD dates.
 */
export const coreClaimsSuite = {
  id: 'core-claims-suite',
  port: 'claims',
  format: 'acord-aligned-json',
  profiles: Object.keys(MAPPERS),

  /**
   * Map a claim bundle to the core payload. Pure.
   * @param {{ claim: object, parties?: object[], vehicles?: object[], properties?: object[] }} bundle
   * @param {'A'|'B'} profile
   * @param {{ coverage?: object, snapshot?: object, triage?: object, config?: object, settings?: object, rqUid: string, now: string, maskPii?: boolean }} opts
   * @returns {{ payload: object, unmapped: string[], warnings: string[] }}
   */
  map(bundle, profile, opts = {}) {
    const mapper = MAPPERS[profile];
    if (!mapper) throw new TypeError(`unknown mapping profile "${profile}"`);
    return mapper({ ...opts, bundle: { parties: [], vehicles: [], properties: [], ...bundle } });
  },

  /**
   * Deliver a payload.
   * target `{ kind: 'inprocess', receive(payload) }` calls the fake core; `{ kind: 'http', url, pinned: { address, family }, transport?, fetch?, timeoutMs? }` POSTs JSON
   * and expects `{ coreClaimNumber }` back.
   * @returns {Promise<{ externalId: string, raw?: object }>}
   */
  async send(payload, target) {
    if (target?.kind === 'inprocess') {
      const res = await target.receive(payload);
      return { externalId: res.coreClaimNumber, raw: res };
    }
    if (target?.kind === 'http') {
      const headers = { 'content-type': 'application/json', accept: 'application/json' };
      const body = JSON.stringify(payload);
      let status;
      let text;
      if (target.fetch) {
        // Test seam. Redirects are never followed; a 3xx is a failed delivery.
        const res = await target.fetch(target.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(target.timeoutMs ?? 10000) });
        status = res.status;
        text = status >= 200 && status < 300 ? await res.text?.().catch(() => null) ?? JSON.stringify(await res.json?.().catch(() => null)) : null;
      } else if (target.pinned) {
        // Connect to the address validated by resolveTarget (resolved once), never to a second DNS answer.
        const res = await (target.transport ?? pinnedRequest)({
          url: new URL(target.url), address: target.pinned.address, family: target.pinned.family, method: 'POST', headers, body, timeoutMs: target.timeoutMs ?? 10000,
        });
        status = res.status;
        text = res.body?.toString('utf8');
      } else {
        throw new TypeError('http target must carry a pinned address');
      }
      if (status >= 300 && status < 400) throw new Error(`core system redirected (${status}); redirects are not followed`);
      if (status < 200 || status >= 300) throw new Error(`core system responded ${status}`);
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* not json */ }
      const externalId = parsed?.coreClaimNumber ?? parsed?.claimNumber;
      if (!externalId) throw new Error('core system response has no coreClaimNumber');
      return { externalId: String(externalId), raw: { coreClaimNumber: String(externalId) } };
    }
    throw new TypeError('unknown send target');
  },
};
