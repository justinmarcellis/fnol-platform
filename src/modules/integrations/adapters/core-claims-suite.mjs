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
   * target `{ kind: 'inprocess', receive(payload) }` calls the fake core; `{ kind: 'http', url, fetch?, timeoutMs? }` POSTs JSON
   * and expects `{ coreClaimNumber }` back.
   * @returns {Promise<{ externalId: string, raw?: object }>}
   */
  async send(payload, target) {
    if (target?.kind === 'inprocess') {
      const res = await target.receive(payload);
      return { externalId: res.coreClaimNumber, raw: res };
    }
    if (target?.kind === 'http') {
      const doFetch = target.fetch ?? globalThis.fetch;
      const res = await doFetch(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(target.timeoutMs ?? 10000),
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`core system responded ${res.status}`);
      const body = await res.json().catch(() => null);
      const externalId = body?.coreClaimNumber ?? body?.claimNumber;
      if (!externalId) throw new Error('core system response has no coreClaimNumber');
      return { externalId: String(externalId), raw: { coreClaimNumber: String(externalId) } };
    }
    throw new TypeError('unknown send target');
  },
};
