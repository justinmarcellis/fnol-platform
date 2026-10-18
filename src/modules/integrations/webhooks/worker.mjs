import { buildHeaders } from './signing.mjs';
import { validateWebhookUrl, resolveAndPin, checkAllowedHost, pinnedRequest } from './url-guard.mjs';
import { toEnvelope } from './outbox.mjs';
import { DEFAULT_MAX_ATTEMPTS } from './service.mjs';

/** Delay before retry n (n = attempts made so far): 30s, 2m, 10m, 1h, 6h, then 6h. */
export const DEFAULT_BACKOFF_MS = [30e3, 120e3, 600e3, 3600e3, 21600e3];

const workers = new WeakMap();

/**
 * Get (or create) the shared delivery worker for a platform instance.
 * @param {object} root root ctx (a tenant-bound ctx is accepted and resolved to its root)
 * @param {object} [overrides] see createWorker
 */
export function getWorker(root, overrides) {
  const r = root.root ?? root;
  if (!workers.has(r)) workers.set(r, createWorker(r));
  const w = workers.get(r);
  if (overrides) w.configure(overrides);
  return w;
}

function truncate(s, n = 200) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}...` : str;
}

/**
 * Webhook delivery worker.
 *  - handleEvent(evt, tctx): bus handler for '*'; creates one delivery per matching subscription and tries it now.
 *  - tick(): retries due deliveries (call from a timer; tests call it directly with a fake clock).
 * Deliveries are idempotent per (subscription, event id): a unique index plus a pre-check.
 * @param {object} root root ctx (needs db, clock, log, crypto, tenants, forTenant)
 * Connection: the host is resolved once (`resolveHost`, default dns.lookup all:true), every address is validated, and the
 * request goes to the pinned address via `transport({ url, address, family, headers, body, signal, timeoutMs })` (default: node:https).
 * `fetch` is a legacy test seam: it receives the original URL plus `init.dispatcher = { pinned: { address, family } }`.
 * @param {{ transport?: Function, fetch?: Function, resolveHost?: Function, timeoutMs?: number, backoffMs?: number[], tickMs?: number, staleMs?: number }} [opts]
 */
export function createWorker(root, opts = {}) {
  const cfg = {
    transport: null,
    fetch: null,
    resolveHost: undefined,
    timeoutMs: 5000,
    backoffMs: DEFAULT_BACKOFF_MS,
    tickMs: Number(process.env.FNOL_WEBHOOK_TICK_MS ?? 15000),
    staleMs: 5 * 60e3,
    ...opts,
  };
  const inFlight = new Set();
  let timer = null;
  let ticking = false;

  const now = () => root.clock.now();

  function loadSub(t, id) {
    return t.get('SELECT * FROM webhook_subscriptions WHERE id = ?', id);
  }

  function finish(t, d, patch) {
    t.update('webhook_deliveries', d.id, { ...patch, at: root.clock.nowIso() });
  }

  /** Make one delivery attempt for a pending delivery row. Never throws. */
  async function attempt(tctx, deliveryId) {
    if (inFlight.has(deliveryId)) return;
    inFlight.add(deliveryId);
    const t = tctx.db;
    try {
      const d = t.get('SELECT * FROM webhook_deliveries WHERE id = ?', deliveryId);
      if (!d || d.status !== 'pending') return;
      const sub = loadSub(t, d.subscription_id);
      if (!sub) return finish(t, d, { status: 'failed', next_attempt_at: null, last_error: 'subscription_deleted' });
      if (!sub.active) return finish(t, d, { status: 'failed', next_attempt_at: null, last_error: 'subscription_inactive' });
      const evtRow = t.get('SELECT event FROM outbox WHERE id = ?', d.event_id);
      if (!evtRow) return finish(t, d, { status: 'failed', next_attempt_at: null, last_error: 'event_not_found' });

      const devMode = Boolean(root.config?.devMode);
      const maxAttempts = t.parseJson(sub.doc, {}).retryPolicy?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      const n = d.attempt + 1;
      let status = null;
      let error = null;

      const body = JSON.stringify(toEnvelope(t.parseJson(evtRow.event, {}), tctx.tenant.id));
      try {
        const v = validateWebhookUrl(sub.url, { devMode });
        if (!v.ok) throw new Error(`blocked: ${v.reason}`);
        const notAllowed = checkAllowedHost(v.url.hostname, tctx.tenant?.config?.notifications?.webhooks?.allowedHosts, { devMode, loopback: v.loopback });
        if (notAllowed) throw new Error(`blocked: ${notAllowed}`);
        // Resolve once; the connection below goes to this address, never to a second DNS answer.
        const pin = await resolveAndPin(v.url, { resolveHost: cfg.resolveHost, allowLoopback: v.loopback });
        if (!pin.ok) throw new Error(`blocked: ${pin.reason}`);
        const secret = tctx.crypto.decryptPii(sub.secret_enc);
        const headers = buildHeaders({ secret, body, eventId: d.event_id, eventType: d.event_type, deliveryId: d.id, attempt: n });
        const ac = new AbortController();
        const timeout = setTimeout(() => ac.abort(), cfg.timeoutMs);
        try {
          // Never follow redirects: a 3xx could bounce the signed body to an unvalidated host.
          let res;
          if (cfg.fetch && !cfg.transport) {
            res = await cfg.fetch(v.url.toString(), {
              method: 'POST', headers, body, redirect: 'manual', signal: ac.signal,
              dispatcher: { pinned: { address: pin.address, family: pin.family } },
            });
            try { await res.body?.cancel?.(); } catch { /* body already consumed */ }
          } else {
            res = await (cfg.transport ?? pinnedRequest)({
              url: v.url, address: pin.address, family: pin.family, method: 'POST', headers, body, signal: ac.signal, timeoutMs: cfg.timeoutMs,
            });
          }
          status = res.status;
        } finally {
          clearTimeout(timeout);
        }
        if (status >= 300 && status < 400) error = `redirect_${status}`;
        else if (!(status >= 200 && status < 300)) error = `http_${status}`;
      } catch (e) {
        error = e?.name === 'AbortError' ? 'timeout' : truncate(e?.cause?.code ?? e?.message ?? e);
      }

      if (!error) {
        finish(t, d, { attempt: n, status: 'succeeded', response_status: status, next_attempt_at: null, last_error: null });
      } else if (n >= maxAttempts || error.startsWith('blocked:')) {
        finish(t, d, { attempt: n, status: 'failed', response_status: status, next_attempt_at: null, last_error: error });
        root.log.warn('webhook delivery failed permanently', { subscriptionId: d.subscription_id, eventId: d.event_id, attempts: n, error });
      } else {
        const delay = cfg.backoffMs[Math.min(n - 1, cfg.backoffMs.length - 1)];
        finish(t, d, {
          attempt: n, status: 'pending', response_status: status, last_error: error,
          next_attempt_at: new Date(now().getTime() + delay).toISOString(),
        });
      }
    } catch (e) {
      root.log.error('webhook attempt crashed', { deliveryId, error: e?.message });
    } finally {
      inFlight.delete(deliveryId);
    }
  }

  return {
    config: cfg,

    /** Override fetch / resolver / timing (tests and embedders). */
    configure(patch) { Object.assign(cfg, patch); return this; },

    /**
     * Bus handler for '*': fan the event out to matching, active subscriptions.
     * @param {object} evt event envelope from the bus
     * @param {object} tctx tenant-bound ctx
     */
    async handleEvent(evt, tctx) {
      const t = tctx.db;
      const subs = t.all('SELECT * FROM webhook_subscriptions WHERE active = 1');
      const created = [];
      for (const sub of subs) {
        const types = t.parseJson(sub.event_types, []);
        if (!types.includes('*') && !types.includes(evt.type)) continue;
        if (t.get('SELECT 1 AS x FROM webhook_deliveries WHERE subscription_id = ? AND event_id = ?', sub.id, evt.id)) continue;
        const id = t.id('whd');
        try {
          // next_attempt_at stays null while the first attempt is in flight.
          t.insert('webhook_deliveries', {
            id, subscription_id: sub.id, event_id: evt.id, event_type: evt.type, attempt: 0, status: 'pending', at: root.clock.nowIso(),
          });
        } catch (e) {
          if (/UNIQUE/i.test(e?.message ?? '')) continue;
          throw e;
        }
        created.push(id);
      }
      await Promise.all(created.map((id) => attempt(tctx, id)));
    },

    /**
     * Retry every pending delivery whose next_attempt_at has passed (and recover stale in-flight rows).
     * @returns {Promise<{ attempted: number }>}
     */
    async tick() {
      if (ticking) return { attempted: 0 };
      ticking = true;
      let attempted = 0;
      try {
        const nowIso = root.clock.nowIso();
        const staleIso = new Date(now().getTime() - cfg.staleMs).toISOString();
        for (const tid of root.tenants.list()) {
          const tctx = root.forTenant(tid);
          const rows = tctx.db.all(
            `SELECT id FROM webhook_deliveries WHERE status = 'pending'
             AND ((next_attempt_at IS NOT NULL AND next_attempt_at <= ?) OR (next_attempt_at IS NULL AND at <= ?))
             ORDER BY seq LIMIT 200`,
            nowIso, staleIso,
          );
          attempted += rows.length;
          await Promise.all(rows.map((r) => attempt(tctx, r.id)));
        }
      } finally {
        ticking = false;
      }
      return { attempted };
    },

    /** Start the background retry timer (unref'd; errors are logged, never thrown). Set FNOL_WEBHOOK_TICK_MS=0 to disable. */
    start() {
      if (timer || !(cfg.tickMs > 0)) return;
      timer = setInterval(() => {
        this.tick().catch((e) => root.log.error('webhook tick failed', { error: e?.message }));
      }, cfg.tickMs);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
