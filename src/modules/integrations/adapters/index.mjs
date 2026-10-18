import { createRegistry } from './port.mjs';
import { coreClaimsSuite } from './core-claims-suite.mjs';
import { hashPayload } from './hash.mjs';
import { migrations as fakeCoreMigrations, receiveClaim, registerFakeCoreRoutes } from './fake-core.mjs';
import { validateWebhookUrl, checkResolvedHost } from '../webhooks/url-guard.mjs';

export { hashPayload } from './hash.mjs';
export { coreClaimsSuite } from './core-claims-suite.mjs';
export { createRegistry } from './port.mjs';
export { receiveClaim, listReceived } from './fake-core.mjs';

/** Tables for the adapters part (core_sync per modules.md#integrations, plus an event ledger and the fake core). */
export const migrations = [
  {
    sql: `
CREATE TABLE IF NOT EXISTS core_sync (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL,
  last_payload_hash TEXT,
  last_event_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_core_sync ON core_sync (tenant_id, claim_id, adapter_id);
CREATE TABLE IF NOT EXISTS core_sync_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_core_sync_events ON core_sync_events (tenant_id, event_id, adapter_id);`,
    tenantTables: ['core_sync', 'core_sync_events'],
  },
  ...fakeCoreMigrations,
];

const DEFAULT_ADAPTER = 'core-claims-suite';
const DEFAULT_PUSH_ON = 'claim.routed';
const PUSH_EVENTS = ['claim.reported', 'claim.routed'];

const defaultRegistry = createRegistry([coreClaimsSuite]);
const services = new WeakMap(); // tenant-bound ctx -> service (event handlers)
const subscribed = new WeakSet(); // root bus objects already subscribed

const portConfig = (config) => config?.integrations?.claimsPort ?? {};
const actorName = (actor) => (typeof actor === 'string' ? actor : actor?.id ?? 'system:integrations');

/**
 * Build the claims-port adapter service for a ctx. Use a tenant-bound ctx for tenant data;
 * a root ctx only supports `routes` and `init`.
 * @param {object} ctx
 * @param {{ registry?: object }} [opts]
 */
export function createAdapterService(ctx, opts = {}) {
  const registry = opts.registry ?? defaultRegistry;

  const tenantId = () => {
    if (!ctx.tenant?.id) throw new ctx.AppError('tenant_required', 'A tenant-bound context is required', 400);
    return ctx.tenant.id;
  };
  const adapterOr404 = (id) => {
    const a = registry.get(id);
    if (!a) throw new ctx.AppError('adapter_not_found', `Adapter "${id}" is not registered`, 404);
    return a;
  };
  const enabledId = () => portConfig(ctx.tenant?.config).adapter ?? DEFAULT_ADAPTER;
  const profileOf = (adapter) => {
    const profile = String(portConfig(ctx.tenant?.config).settings?.profile ?? 'A').toUpperCase();
    if (adapter.profiles && !adapter.profiles.includes(profile)) {
      throw new ctx.AppError('invalid_adapter_settings', `Mapping profile "${profile}" is not supported by ${adapter.id}`, 422);
    }
    return profile;
  };

  /** Load claim bundle and optional triage/coverage inputs. Missing optional modules become warnings. */
  async function gather(claimId) {
    const warnings = [];
    const claims = ctx.modules?.claims;
    if (!claims?.getClaimBundle) throw new ctx.AppError('claims_unavailable', 'Claims module is not available', 503);
    const bundle = await claims.getClaimBundle(claimId);
    const optional = async (mod, fn, ...args) => {
      try {
        return (await ctx.modules?.[mod]?.[fn]?.(...args)) ?? null;
      } catch (e) {
        warnings.push(`${mod}.${fn} failed: ${e?.code ?? 'error'}`);
        return null;
      }
    };
    const triage = await optional('triage', 'getLatestTriage', claimId);
    const coverage = await optional('coverage', 'getLatestVerification', claimId);
    const snapshot = coverage?.policySnapshotId ? await optional('coverage', 'getSnapshotById', coverage.policySnapshotId) : null;
    return { bundle, triage, coverage, snapshot, warnings };
  }

  async function buildMapping(adapter, claimId, { eventId, maskPii = false } = {}) {
    const profile = profileOf(adapter);
    const config = ctx.tenant.config;
    const inputs = await gather(claimId);
    const mapped = adapter.map(inputs.bundle, profile, {
      coverage: inputs.coverage,
      snapshot: inputs.snapshot,
      triage: inputs.triage,
      config,
      settings: portConfig(config).settings ?? {},
      rqUid: eventId ?? `rq_${claimId}`,
      now: ctx.clock.nowIso(),
      maskPii,
    });
    return { profile, ...mapped, warnings: [...inputs.warnings, ...mapped.warnings] };
  }

  /** Resolve where to send: the in-process fake core by default, or an HTTP URL from tenant settings. */
  async function resolveTarget() {
    const raw = portConfig(ctx.tenant.config).settings?.target;
    const url = typeof raw === 'string' && raw !== 'fake-core' ? raw : raw?.url;
    if (!url) return { kind: 'inprocess', receive: (payload) => receiveClaim(ctx, payload, { hash: hashPayload }) };
    const check = validateWebhookUrl(url, { devMode: Boolean(ctx.config?.devMode) });
    if (!check.ok) throw new Error(`target url rejected: ${check.reason}`);
    if (!check.loopback) {
      const blocked = await checkResolvedHost(check.url);
      if (blocked) throw new Error(`target url rejected: ${blocked}`);
    }
    return { kind: 'http', url: check.url.toString() };
  }

  const service = {
    /** @returns {{ id: string, port: string, format: string, enabled: boolean, profiles?: string[], profile?: string }[]} */
    listAdapters() {
      const enabled = enabledId();
      return registry.list().map((a) => {
        const on = a.id === enabled;
        let profile;
        if (on && a.profiles) {
          try { profile = profileOf(a); } catch { profile = undefined; }
        }
        return { id: a.id, port: a.port ?? 'claims', format: a.format, enabled: on, ...(a.profiles ? { profiles: a.profiles } : {}), ...(profile ? { profile } : {}) };
      });
    },

    /**
     * Map a claim without sending and without writing core_sync. PII is masked unless `unmasked` is set.
     * @returns {Promise<{ adapterId: string, format: string, profile: string, payload: object, unmapped: string[], warnings: string[] }>}
     */
    async previewMapping(adapterId, claimId, { unmasked = false } = {}) {
      tenantId();
      const adapter = adapterOr404(adapterId);
      const m = await buildMapping(adapter, claimId, { maskPii: !unmasked });
      const warnings = unmasked ? m.warnings : [...m.warnings, 'PII fields are masked in this preview'];
      return { adapterId, format: adapter.format, profile: m.profile, payload: m.payload, unmapped: m.unmapped, warnings };
    },

    /**
     * Map, send and record. Send failures are recorded (core_sync status 'failed') and returned, not thrown.
     * With `eventId` (bus-triggered) the push runs once per event and is a no-op when the payload hash is unchanged.
     * @returns {Promise<{ externalId: string|null, status: 'synced'|'failed', unchanged?: boolean, duplicateEvent?: boolean, error?: string }>}
     */
    async pushClaim(adapterId, claimId, { actor, eventId } = {}) {
      tenantId();
      const adapter = adapterOr404(adapterId);
      if (enabledId() !== adapter.id) throw new ctx.AppError('adapter_not_enabled', `Adapter "${adapterId}" is not enabled for this tenant`, 409);

      const existing = ctx.db.get('SELECT * FROM core_sync WHERE claim_id = ? AND adapter_id = ?', claimId, adapter.id);
      if (eventId) {
        const seen = ctx.db.get('SELECT seq FROM core_sync_events WHERE event_id = ? AND adapter_id = ?', eventId, adapter.id);
        if (seen) return { externalId: existing?.external_id ?? null, status: existing?.status === 'failed' ? 'failed' : 'synced', duplicateEvent: true };
      }

      const mapped = await buildMapping(adapter, claimId, { eventId });
      if (eventId) ctx.db.insert('core_sync_events', { event_id: eventId, adapter_id: adapter.id, claim_id: claimId, at: ctx.clock.nowIso() });
      const hash = hashPayload(mapped.payload);
      if (eventId && existing?.status === 'synced' && existing.last_payload_hash === hash) {
        ctx.db.update('core_sync', existing.id, { last_event_id: eventId, updated_at: ctx.clock.nowIso() });
        return { externalId: existing.external_id, status: 'synced', unchanged: true };
      }

      let externalId = null;
      let error = null;
      try {
        const target = await resolveTarget();
        ({ externalId } = await adapter.send(mapped.payload, target));
      } catch (e) {
        error = String(e?.message ?? e).slice(0, 300);
      }
      const status = error ? 'failed' : 'synced';
      const now = ctx.clock.nowIso();
      const row = {
        external_id: error ? existing?.external_id ?? null : externalId,
        status,
        last_payload_hash: error ? existing?.last_payload_hash ?? null : hash,
        last_event_id: eventId ?? existing?.last_event_id ?? null,
        attempts: (existing?.attempts ?? 0) + 1,
        last_error: error,
        updated_at: now,
      };
      if (existing) ctx.db.update('core_sync', existing.id, row);
      else ctx.db.insert('core_sync', { id: ctx.db.id('syn'), claim_id: claimId, adapter_id: adapter.id, ...row });

      try {
        await ctx.modules.claims.setExternalRef(claimId, { system: adapter.id, id: row.external_id ?? 'unassigned', status });
      } catch (e) {
        ctx.log.warn('setExternalRef failed', { claimId, code: e?.code });
      }
      ctx.audit.record({
        actor: actorName(actor), action: 'integrations.core.push', entityType: 'claim', entityId: claimId,
        details: { adapterId: adapter.id, status, externalId: row.external_id, payloadHash: hash, eventId: eventId ?? null, attempts: row.attempts },
      });
      return error ? { externalId: row.external_id, status, error } : { externalId, status };
    },

    /** Register the fake core receiver routes. */
    routes(router) {
      registerFakeCoreRoutes(router, { hash: hashPayload });
    },

    /**
     * Subscribe to the push events once per bus. The handler pushes only when the tenant's
     * claimsPort.pushOn names the event ('manual' disables event pushes).
     */
    init(rootCtx = ctx) {
      if (subscribed.has(rootCtx.bus)) return;
      subscribed.add(rootCtx.bus);
      for (const type of PUSH_EVENTS) {
        rootCtx.bus.on(type, async (evt, tctx) => {
          const tid = evt.tenantid ?? evt.tenantId;
          const t = tctx ?? rootCtx.forTenant(tid);
          if ((portConfig(t.tenant.config).pushOn ?? DEFAULT_PUSH_ON) !== type) return;
          if (!services.has(t)) services.set(t, createAdapterService(t, opts));
          try {
            await services.get(t).pushClaim(portConfig(t.tenant.config).adapter ?? DEFAULT_ADAPTER, evt.data.claimId, { actor: 'system:integrations', eventId: evt.id });
          } catch (e) {
            t.log.error('core push failed', { claimId: evt.data?.claimId, eventId: evt.id, code: e?.code, error: e?.message });
          }
        }, { name: `integrations:adapters:${type}` });
      }
    },
  };
  return service;
}
