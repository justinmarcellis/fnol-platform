// Async store port (S5-PLT-01 spike). A backend-neutral, promise-based view of the tenant-scoped
// store described in architecture/core-runtime-api.md. store.mjs is untouched; wrapSyncStore()
// adapts the existing synchronous SQLite store so callers can be moved to `await` one at a time
// before any other backend (for example Cloud SQL Postgres) exists.
// See architecture/spikes/cloud-sql-store.md.

/**
 * @typedef {Record<string, unknown>} Row
 * @typedef {{ where?: Record<string, unknown>, orderBy?: string, limit?: number, offset?: number }} ListOptions
 *   `where` is equality-only (null means IS NULL). `orderBy` is "col" or "col DESC", comma separated.
 *
 * @typedef {object} StoreHandle  Tenant-bound (forTenant) or system handle. Every method is async.
 * @property {string|null} tenantId null for the system handle
 * @property {(sql: string, ...params: unknown[]) => Promise<Row|undefined>} get      first row of a SQL query
 * @property {(sql: string, ...params: unknown[]) => Promise<Row[]>} all              all rows of a SQL query
 * @property {(sql: string, ...params: unknown[]) => Promise<{changes: number, lastInsertRowid: number}>} run
 * @property {(table: string, obj: Row) => Promise<Row>} insert                       tenant_id is forced to the bound tenant
 * @property {(table: string, id: string) => Promise<Row|undefined>} getById
 * @property {(table: string, opts?: ListOptions) => Promise<Row[]>} list
 * @property {(table: string, where?: Record<string, unknown>) => Promise<number>} count
 * @property {(table: string, id: string, patch: Row) => Promise<number>} update      rejects when patch has tenant_id (tenant handle)
 * @property {(table: string, id: string) => Promise<number>} delete                   returns rows deleted
 * @property {<T>(fn: (tx: StoreHandle) => Promise<T>|T) => Promise<T>} transaction
 *   Commit when fn resolves, rollback when it rejects. Work must go through `tx`. Nested calls become savepoints.
 *   Do not do slow external I/O (HTTP, AI) inside fn: the transaction holds a connection.
 *
 * @typedef {object} StorePort
 * @property {(tenantId: string) => StoreHandle} forTenant
 * @property {StoreHandle} system
 * @property {(moduleName: string, migrations?: Array<string|{sql: string, tenantTables?: string[], systemTables?: string[]}>) => Promise<void>} migrate
 * @property {() => Promise<void>} close
 * @property {(prefix: string) => string} id         pure helpers stay synchronous
 * @property {(v: unknown) => string|null} toJson
 * @property {(s: string|null, fallback?: unknown) => unknown} parseJson
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (n) => {
  if (typeof n !== 'string' || !IDENT.test(n)) throw new Error(`Invalid identifier: ${n}`);
  return n;
};

function whereClause(where = {}) {
  const parts = [];
  const params = [];
  for (const [k, v] of Object.entries(where)) {
    ident(k);
    if (v === null || v === undefined) parts.push(`${k} IS NULL`);
    else { parts.push(`${k} = ?`); params.push(v); }
  }
  return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params };
}

function orderClause(orderBy) {
  if (!orderBy) return '';
  const items = String(orderBy).split(',').map((p) => {
    const m = /^\s*([A-Za-z_]\w*)(?:\s+(ASC|DESC))?\s*$/i.exec(p);
    if (!m) throw new Error(`Invalid orderBy: ${orderBy}`);
    return `${m[1]}${m[2] ? ` ${m[2].toUpperCase()}` : ''}`;
  });
  return ` ORDER BY ${items.join(', ')}`;
}

/**
 * Wrap the synchronous SQLite store (createStore from store.mjs) in the async port.
 * Transactions on the single SQLite connection are serialized: while one is open, calls made
 * outside it wait, so unrelated async work never joins another request's transaction.
 * @param {object} store result of createStore()
 * @returns {StorePort}
 */
export function wrapSyncStore(store) {
  let active = null; // promise of the currently open top-level transaction
  let spN = 0;

  /** @returns {StoreHandle} */
  function makeHandle(base, inTx) {
    const gate = async () => { if (!inTx) while (active) await active.catch(() => {}); };
    const handle = {
      tenantId: base.tenantId ?? null,
      async get(sql, ...p) { await gate(); return base.get(sql, ...p); },
      async all(sql, ...p) { await gate(); return base.all(sql, ...p); },
      async run(sql, ...p) { await gate(); return base.run(sql, ...p); },
      async insert(table, obj) { await gate(); return base.insert(table, obj); },
      async update(table, id, patch) { await gate(); return base.update(table, id, patch); },
      async getById(table, id) { await gate(); return base.get(`SELECT * FROM ${ident(table)} WHERE id = ?`, id); },
      async list(table, opts = {}) {
        await gate();
        const w = whereClause(opts.where);
        let sql = `SELECT * FROM ${ident(table)}${w.sql}${orderClause(opts.orderBy)}`;
        const params = [...w.params];
        if (opts.limit !== undefined) { sql += ' LIMIT ?'; params.push(Number(opts.limit)); }
        if (opts.offset !== undefined) { sql += ' OFFSET ?'; params.push(Number(opts.offset)); }
        return base.all(sql, ...params);
      },
      async count(table, where) {
        await gate();
        const w = whereClause(where);
        return Number(base.get(`SELECT COUNT(*) AS n FROM ${ident(table)}${w.sql}`, ...w.params).n);
      },
      async delete(table, id) { await gate(); return base.run(`DELETE FROM ${ident(table)} WHERE id = ?`, id).changes; },
      async transaction(fn) {
        if (inTx) { // nested: savepoint
          const sp = `port_sp_${spN++}`;
          store.raw.exec(`SAVEPOINT ${sp}`);
          try {
            const out = await fn(handle);
            store.raw.exec(`RELEASE ${sp}`);
            return out;
          } catch (e) {
            store.raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
            throw e;
          }
        }
        while (active) await active.catch(() => {});
        const run = (async () => {
          store.raw.exec('BEGIN IMMEDIATE');
          const tx = makeHandle(base, true);
          try {
            const out = await fn(tx);
            store.raw.exec('COMMIT');
            return out;
          } catch (e) {
            store.raw.exec('ROLLBACK');
            throw e;
          }
        })();
        active = run;
        try { return await run; } finally { if (active === run) active = null; }
      },
    };
    return handle;
  }

  return {
    forTenant: (tenantId) => makeHandle(store.forTenant(tenantId), false),
    system: makeHandle({ ...store.system, tenantId: null }, false),
    async migrate(moduleName, migrations = []) { while (active) await active.catch(() => {}); store.migrate(moduleName, migrations); },
    async close() { while (active) await active.catch(() => {}); store.close(); },
    id: store.id,
    toJson: store.toJson,
    parseJson: store.parseJson,
  };
}
