import { generateSecret } from './signing.mjs';
import { validateWebhookUrl } from './url-guard.mjs';

const EVENT_TYPE_RE = /^(?:(?:claim|tenant)\.[a-z_.]+|\*)$/;
const KNOWN_INPUT = new Set(['url', 'eventTypes', 'description', 'active', 'retryPolicy', 'tenantId']);
const KNOWN_PATCH = new Set([...KNOWN_INPUT, 'rotateSecret']);
export const DEFAULT_MAX_ATTEMPTS = 5;

/** Opaque cursor helpers (base64url of a JSON number). */
export const encodeCursor = (n) => Buffer.from(JSON.stringify({ n })).toString('base64url');
export function decodeCursor(c) {
  if (c === undefined || c === null || c === '') return null;
  try {
    const n = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8'))?.n;
    if (Number.isInteger(n) && n >= 0) return n;
  } catch { /* fall through */ }
  return undefined;
}

/** Clamp a limit query value to 1..200 (default 50); throws 400 on garbage. */
export function parseLimit(ctx, v) {
  if (v === undefined || v === '') return 50;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ctx.AppError('invalid_query', 'limit must be a positive integer', 400);
  return Math.min(n, 200);
}

function invalid(ctx, message) {
  return new ctx.AppError('validation_failed', message, 422);
}

function actorId(actor) {
  return typeof actor === 'string' ? actor : actor?.id ?? 'system';
}

/**
 * Webhook subscription + delivery-log service. `ctx` must be tenant-bound (ctx.forTenant(id)).
 * @param {object} ctx tenant-bound context
 * @returns {object}
 */
export function createWebhookService(ctx) {
  const tenantId = () => {
    if (!ctx.tenant?.id) throw new ctx.AppError('tenant_required', 'Webhook service requires a tenant-bound context', 500);
    return ctx.tenant.id;
  };
  const devMode = () => Boolean((ctx.root ?? ctx).config?.devMode);

  function toSubscription(row) {
    const doc = ctx.db.parseJson(row.doc, {});
    const sub = {
      id: row.id,
      tenantId: row.tenant_id,
      url: row.url,
      eventTypes: ctx.db.parseJson(row.event_types, []),
      active: Boolean(row.active),
      secretRef: `webhook_subscriptions/${row.id}`,
      retryPolicy: doc.retryPolicy ?? { maxAttempts: DEFAULT_MAX_ATTEMPTS, backoff: 'exponential' },
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
    if (doc.description !== undefined) sub.description = doc.description;
    return sub;
  }

  function load(id) {
    const row = ctx.db.get('SELECT * FROM webhook_subscriptions WHERE id = ?', id);
    if (!row) throw new ctx.AppError('not_found', 'Webhook subscription not found', 404);
    return row;
  }

  function checkBody(input, allowed) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid(ctx, 'body must be a JSON object');
    if (input.tenantId !== undefined && input.tenantId !== tenantId()) {
      throw new ctx.AppError('tenant_mismatch', 'tenantId does not match the authenticated tenant', 403);
    }
    const extra = Object.keys(input).filter((k) => !allowed.has(k));
    if (extra.length) throw invalid(ctx, `unknown field(s): ${extra.join(', ')}`);
  }

  function checkUrl(url) {
    const v = validateWebhookUrl(url, { devMode: devMode() });
    if (!v.ok) throw invalid(ctx, v.reason);
    return v.url.toString();
  }

  function checkEventTypes(types) {
    if (!Array.isArray(types) || !types.length) throw invalid(ctx, 'eventTypes must be a non-empty array');
    const bad = types.filter((t) => typeof t !== 'string' || !EVENT_TYPE_RE.test(t));
    if (bad.length) throw invalid(ctx, `invalid event type(s): ${bad.map(String).join(', ')}`);
    return [...new Set(types)];
  }

  function checkRetryPolicy(rp) {
    if (rp === undefined) return { maxAttempts: DEFAULT_MAX_ATTEMPTS, backoff: 'exponential' };
    const max = rp?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!rp || typeof rp !== 'object' || !Number.isInteger(max) || max < 1 || max > 10) throw invalid(ctx, 'retryPolicy.maxAttempts must be an integer 1..10');
    if (rp.backoff !== undefined && rp.backoff !== 'exponential') throw invalid(ctx, 'retryPolicy.backoff must be "exponential"');
    return { maxAttempts: max, backoff: 'exponential' };
  }

  const checkDescription = (d) => {
    if (typeof d !== 'string' || d.length > 500) throw invalid(ctx, 'description must be a string up to 500 characters');
    return d;
  };
  const checkActive = (a) => {
    if (typeof a !== 'boolean') throw invalid(ctx, 'active must be a boolean');
    return a;
  };

  return {
    /** @returns {Promise<object[]>} WebhookSubscription[] (never includes secrets) */
    async listSubscriptions() {
      tenantId();
      return ctx.db.all('SELECT * FROM webhook_subscriptions ORDER BY seq').map(toSubscription);
    },

    /** @returns {Promise<object>} WebhookSubscription */
    async getSubscription(id) {
      return toSubscription(load(id));
    },

    /**
     * Create a subscription. The signing secret is returned exactly once, in the `secret` property.
     * @param {{ url: string, eventTypes: string[], description?: string, active?: boolean, retryPolicy?: object }} input
     * @param {{ actor?: object }} [opts]
     * @returns {Promise<object>} WebhookSubscription & { secret }
     */
    async createSubscription(input, { actor } = {}) {
      tenantId();
      checkBody(input, KNOWN_INPUT);
      const url = checkUrl(input.url);
      const eventTypes = checkEventTypes(input.eventTypes);
      const now = ctx.clock.nowIso();
      const doc = { retryPolicy: checkRetryPolicy(input.retryPolicy), createdAt: now, updatedAt: now };
      if (input.description !== undefined) doc.description = checkDescription(input.description);
      const active = input.active === undefined ? true : checkActive(input.active);
      const secret = generateSecret();
      const id = ctx.db.id('whk');
      ctx.db.transaction(() => {
        ctx.db.insert('webhook_subscriptions', {
          id, url, event_types: eventTypes, active, secret_enc: ctx.crypto.encryptPii(secret), doc,
        });
        ctx.audit.record({
          actor: actorId(actor), action: 'webhook.created', entityType: 'webhook_subscription', entityId: id,
          details: { url, eventTypes, active },
        });
      });
      return { ...toSubscription(load(id)), secret };
    },

    /**
     * Patch a subscription. `rotateSecret: true` issues a new secret, returned once in `secret`.
     * @returns {Promise<object>} WebhookSubscription (& secret when rotated)
     */
    async updateSubscription(id, patch, { actor } = {}) {
      tenantId();
      checkBody(patch, KNOWN_PATCH);
      const row = load(id);
      const doc = ctx.db.parseJson(row.doc, {});
      const cols = {};
      const changed = [];
      if (patch.url !== undefined) { cols.url = checkUrl(patch.url); changed.push('url'); }
      if (patch.eventTypes !== undefined) { cols.event_types = checkEventTypes(patch.eventTypes); changed.push('eventTypes'); }
      if (patch.active !== undefined) { cols.active = checkActive(patch.active); changed.push('active'); }
      if (patch.description !== undefined) { doc.description = checkDescription(patch.description); changed.push('description'); }
      if (patch.retryPolicy !== undefined) { doc.retryPolicy = checkRetryPolicy(patch.retryPolicy); changed.push('retryPolicy'); }
      let secret;
      if (patch.rotateSecret !== undefined) {
        if (typeof patch.rotateSecret !== 'boolean') throw invalid(ctx, 'rotateSecret must be a boolean');
        if (patch.rotateSecret) {
          secret = generateSecret();
          cols.secret_enc = ctx.crypto.encryptPii(secret);
          changed.push('secret');
        }
      }
      doc.updatedAt = ctx.clock.nowIso();
      ctx.db.transaction(() => {
        ctx.db.update('webhook_subscriptions', id, { ...cols, doc });
        ctx.audit.record({
          actor: actorId(actor), action: 'webhook.updated', entityType: 'webhook_subscription', entityId: id,
          details: { changed },
        });
      });
      const out = toSubscription(load(id));
      return secret ? { ...out, secret } : out;
    },

    /** Delete a subscription; its delivery log is kept for audit. */
    async deleteSubscription(id, { actor } = {}) {
      tenantId();
      load(id);
      ctx.db.transaction(() => {
        ctx.db.run('DELETE FROM webhook_subscriptions WHERE id = ?', id);
        ctx.audit.record({ actor: actorId(actor), action: 'webhook.deleted', entityType: 'webhook_subscription', entityId: id });
      });
    },

    /**
     * Delivery log for one subscription, newest first, cursor-paginated.
     * @param {string} subscriptionId
     * @param {{ limit?: number|string, cursor?: string }} [page]
     * @returns {Promise<{ items: object[], nextCursor: string|null }>}
     */
    async listDeliveries(subscriptionId, page = {}) {
      tenantId();
      load(subscriptionId);
      const limit = parseLimit(ctx, page.limit);
      const before = decodeCursor(page.cursor);
      if (before === undefined) throw new ctx.AppError('invalid_cursor', 'cursor is not valid', 400);
      const rows = before === null
        ? ctx.db.all('SELECT * FROM webhook_deliveries WHERE subscription_id = ? ORDER BY seq DESC LIMIT ?', subscriptionId, limit + 1)
        : ctx.db.all('SELECT * FROM webhook_deliveries WHERE subscription_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', subscriptionId, before, limit + 1);
      const more = rows.length > limit;
      const items = rows.slice(0, limit).map((r) => {
        const d = {
          id: r.id, eventId: r.event_id, eventType: r.event_type, attempt: r.attempt, status: r.status, at: r.at,
        };
        if (r.response_status !== null) d.responseStatus = r.response_status;
        if (r.next_attempt_at) d.nextAttemptAt = r.next_attempt_at;
        if (r.last_error) d.lastError = r.last_error;
        return d;
      });
      const nextCursor = more ? encodeCursor(rows[limit - 1].seq) : null;
      return { items, nextCursor };
    },
  };
}
