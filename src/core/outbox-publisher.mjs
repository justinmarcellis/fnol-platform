/**
 * Outbox -> Pub/Sub publisher (S5-PLT-02 spike). Does not touch bus.mjs or store.mjs:
 * rows are read and marked through injected functions.
 *
 * Row shape (bus.mjs outbox table): { id, tenant_id, seq, type, subject, event (JSON text), status, ... }.
 * Publisher port: { publish({ data, attributes, orderingKey }) -> Promise<{ messageId }>, resumePublish?(orderingKey) }.
 */
import { gcpFetch } from './gcp-auth.mjs';

/**
 * @param {{ readUndelivered: () => Promise<object[]>|object[], markPublished: (ids: string[]) => Promise<void>|void,
 *   publisher: { publish: Function, resumePublish?: Function }, log?: { error?: Function, info?: Function } }} deps
 */
export function createOutboxPublisher(deps) {
  const { readUndelivered, markPublished, publisher, log } = deps;
  for (const [k, v] of Object.entries({ readUndelivered, markPublished })) {
    if (typeof v !== 'function') throw new TypeError(`${k} must be a function`);
  }
  if (!publisher || typeof publisher.publish !== 'function') throw new TypeError('publisher.publish must be a function');
  const halted = new Set(); // tenants whose last run failed; ordering key is resumed before retry

  return {
    /**
     * Publish undelivered rows in (tenant_id, seq) order. Marks a row published only after the ack.
     * A tenant halts at its first failure (later rows stay pending); other tenants continue.
     * @returns {Promise<{ published: string[], failed: Array<{ tenantId: string, id: string, error: string }>, halted: string[] }>}
     */
    async publishPending() {
      const rows = [...(await readUndelivered())].sort((a, b) =>
        a.tenant_id < b.tenant_id ? -1 : a.tenant_id > b.tenant_id ? 1 : a.seq - b.seq);
      const result = { published: [], failed: [], halted: [] };
      const skip = new Set();
      for (const row of rows) {
        const tenantId = row.tenant_id;
        if (skip.has(tenantId)) continue;
        try {
          if (halted.has(tenantId)) {
            await publisher.resumePublish?.(tenantId);
            halted.delete(tenantId);
          }
          await publisher.publish({
            data: row.event,
            orderingKey: tenantId,
            attributes: { outboxId: String(row.id), tenant_id: String(tenantId), type: String(row.type), seq: String(row.seq) },
          });
          await markPublished([row.id]);
          result.published.push(row.id);
        } catch (e) {
          const error = e?.message ?? String(e);
          halted.add(tenantId);
          skip.add(tenantId);
          result.failed.push({ tenantId, id: row.id, error });
          result.halted.push(tenantId);
          log?.error?.('outbox publish failed', { tenantId, outboxId: row.id, error });
        }
      }
      return result;
    },
  };
}

/**
 * Pub/Sub REST publisher. Ordered keys that fail are paused locally until resumePublish(key),
 * mirroring client-library semantics so ordering is never skipped silently.
 * @param {{ project: string, topic: string, tokenProvider: object, fetch?: typeof fetch, baseUrl?: string }} opts
 */
export function createPubSubRestPublisher(opts) {
  const { project, topic, tokenProvider } = opts;
  if (!project || !topic || !tokenProvider) throw new TypeError('project, topic and tokenProvider are required');
  const baseUrl = opts.baseUrl ?? 'https://pubsub.googleapis.com';
  const paused = new Set();
  return {
    /** @param {{ data: string, attributes?: Record<string,string>, orderingKey?: string }} msg */
    async publish(msg) {
      const key = msg.orderingKey;
      if (key && paused.has(key)) throw new Error(`ordering key paused after failure; call resumePublish (${key})`);
      const body = {
        messages: [{
          data: Buffer.from(msg.data, 'utf8').toString('base64'),
          attributes: msg.attributes ?? {},
          ...(key ? { orderingKey: key } : {}),
        }],
      };
      const url = `${baseUrl}/v1/projects/${encodeURIComponent(project)}/topics/${encodeURIComponent(topic)}:publish`;
      try {
        const res = await gcpFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }, { tokenProvider, fetch: opts.fetch });
        if (!res.ok) throw new Error(`pubsub publish returned HTTP ${res.status}`);
        const json = await res.json();
        const messageId = json?.messageIds?.[0];
        if (!messageId) throw new Error('pubsub publish response missing messageIds');
        return { messageId };
      } catch (e) {
        if (key) paused.add(key);
        throw e;
      }
    },
    /** Clear the paused state of an ordering key so publishing may continue. */
    resumePublish(orderingKey) { paused.delete(orderingKey); },
  };
}
