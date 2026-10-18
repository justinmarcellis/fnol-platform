import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORDS = new Set(['where', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'full', 'natural', 'on', 'using',
  'group', 'order', 'limit', 'having', 'union', 'except', 'intersect', 'window', 'returning', 'set', 'values', 'select', 'offset']);

const ident = (n) => {
  if (!IDENT.test(n)) throw new Error(`Invalid identifier: ${n}`);
  return n;
};
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const normalizeRow = (r) => {
  if (!r) return r;
  const o = {};
  for (const [k, v] of Object.entries(r)) o[k] = num(v);
  return o;
};
/** Serialize a value for a SQLite parameter (objects become JSON, booleans 0/1, undefined null). */
function param(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

/**
 * Normalize a migration entry. Entries are SQL strings or { sql, tenantTables, systemTables }.
 * Tables created with a tenant_id column are tenant tables automatically unless listed in systemTables.
 */
export function defineMigration(sql, tenantTables = [], systemTables = []) {
  return { sql, tenantTables, systemTables };
}

/**
 * SQLite store with a tenant-scoped facade.
 * @param {string} dbPath file path or ':memory:'
 */
export function createStore(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const tenantTables = new Set();
  const stmts = new Map();
  let depth = 0;

  const prepare = (sql) => {
    let s = stmts.get(sql);
    if (!s) { s = raw.prepare(sql); stmts.set(sql, s); }
    return s;
  };
  const isTenantTable = (name) => tenantTables.has(String(name).toLowerCase());
  const registerTenantTables = (names) => names.forEach((n) => tenantTables.add(ident(n).toLowerCase()));

  /** Run fn inside a transaction (savepoint if nested). fn must be synchronous. */
  function transaction(fn) {
    const sp = `sp_${depth}`;
    raw.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    depth++;
    try {
      const out = fn();
      if (out && typeof out.then === 'function') throw new Error('transaction callback must be synchronous');
      depth--;
      raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (e) {
      depth--;
      raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }

  /** Names of tenant tables referenced by a statement (word match, conservative). */
  function referencedTenantTables(sql) {
    const found = [];
    for (const t of tenantTables) if (new RegExp(`\\b${t}\\b`, 'i').test(sql)) found.push(t);
    return found;
  }

  const FROM_RE = /\b(FROM|JOIN)\s+([A-Za-z_]\w*)(\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi;
  function scopeFrom(sql) {
    if (/FROM\s+\w+(\s+(AS\s+)?\w+)?\s*,/i.test(sql)) {
      throw new Error('Comma joins are not supported on tenant tables; use JOIN');
    }
    return sql.replace(FROM_RE, (m, kw, table, aliasPart, alias) => {
      if (!isTenantTable(table)) return m;
      const useAlias = alias && !KEYWORDS.has(alias.toLowerCase());
      const tail = useAlias ? '' : (aliasPart || '');
      return `${kw} (SELECT * FROM ${table} WHERE tenant_id = :__tenant) AS ${useAlias ? alias : table}${tail}`;
    });
  }

  function injectWhere(sql, headLen) {
    const head = sql.slice(0, headLen);
    const tail = sql.slice(headLen);
    const term = /\s+(RETURNING|ORDER\s+BY|LIMIT)\b/i.exec(tail);
    const cut = term ? term.index : tail.length;
    const body = tail.slice(0, cut);
    const rest = tail.slice(cut);
    const w = /\bWHERE\b/i.exec(body);
    if (!w) return `${head}${body} WHERE tenant_id = :__tenant${rest}`;
    const before = body.slice(0, w.index);
    const cond = body.slice(w.index + 5);
    return `${head}${before}WHERE tenant_id = :__tenant AND (${cond})${rest}`;
  }

  /**
   * Refuse SQL shapes the rewriter cannot scope (INC-1): quoted or schema-qualified
   * names of tenant tables, and any statement that assigns tenant_id.
   */
  function guardScoped(sql) {
    for (const t of tenantTables) {
      const quoted = new RegExp(`\\b(FROM|JOIN|UPDATE|INTO)\\s+["\`\\[]${t}["\`\\]]`, 'i');
      const qualified = new RegExp(`\\b(FROM|JOIN|UPDATE|INTO)\\s+["\`\\[]?\\w+["\`\\]]?\\s*\\.\\s*["\`\\[]?${t}\\b`, 'i');
      if (quoted.test(sql) || qualified.test(sql)) {
        throw new Error(`Quoted or schema-qualified reference to tenant table ${t} is not allowed through tenant scope`);
      }
    }
    if (/\bSET\b[\s\S]*\btenant_id\s*=/i.test(sql)) throw new Error('tenant_id cannot be changed through tenant scope');
  }

  /** Rewrite SQL so every tenant table access is filtered by :__tenant. */
  function rewrite(sql) {
    guardScoped(sql);
    const s = sql.trim().replace(/;+\s*$/, '');
    const kind = /^\s*(\w+)/.exec(s)?.[1]?.toLowerCase();
    if (kind === 'select' || kind === 'with') return scopeFrom(s);
    if (kind === 'insert') {
      const into = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_]\w*)/i.exec(s);
      if (into && isTenantTable(into[1])) throw new Error(`Use insert('${into[1]}', obj) for tenant table inserts`);
      return scopeFrom(s);
    }
    if (kind === 'update' || kind === 'delete') {
      const head = kind === 'update'
        ? /^\s*UPDATE\s+(?:OR\s+\w+\s+)?([A-Za-z_]\w*)/i.exec(s)
        : /^\s*DELETE\s+FROM\s+([A-Za-z_]\w*)/i.exec(s);
      if (!head) throw new Error('Unsupported statement');
      let out = s;
      let headLen = head[0].length;
      if (isTenantTable(head[1])) {
        out = injectWhere(s, headLen);
      }
      const newHead = out.slice(0, headLen);
      return newHead + scopeFrom(out.slice(headLen));
    }
    throw new Error(`Statement type not allowed through tenant scope: ${kind}`);
  }

  function exec(sql, tenantId, params, mode) {
    const finalSql = tenantId === null ? sql : rewrite(sql);
    const stmt = prepare(finalSql);
    const args = params.map(param);
    const full = tenantId !== null && finalSql.includes(':__tenant') ? [{ __tenant: tenantId }, ...args] : args;
    if (mode === 'get') return normalizeRow(stmt.get(...full));
    if (mode === 'all') return stmt.all(...full).map(normalizeRow);
    const r = stmt.run(...full);
    return { changes: num(r.changes), lastInsertRowid: num(r.lastInsertRowid) };
  }

  function guardSystem(sql) {
    const hit = referencedTenantTables(sql);
    if (hit.length) {
      throw new Error(`Unscoped query on tenant table(s) ${hit.join(', ')}: use ctx.db.forTenant(tenantId)`);
    }
  }

  function buildInsert(table, obj, tenantId) {
    ident(table);
    const row = tenantId === null ? { ...obj } : { ...obj, tenant_id: tenantId };
    const cols = Object.keys(row).map(ident);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    return { sql, args: cols.map((c) => param(row[c])) };
  }
  function buildUpdate(table, id, patch, tenantId) {
    ident(table);
    if (tenantId !== null && 'tenant_id' in patch) throw new Error('tenant_id cannot be changed through tenant scope');
    const cols = Object.keys(patch).map(ident);
    if (!cols.length) return null;
    const scope = tenantId === null ? '' : ' AND tenant_id = ?';
    const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?${scope}`;
    return { sql, args: [...cols.map((c) => param(patch[c])), id, ...(tenantId === null ? [] : [tenantId])] };
  }

  const system = {
    get: (sql, ...p) => { guardSystem(sql); return exec(sql, null, p, 'get'); },
    all: (sql, ...p) => { guardSystem(sql); return exec(sql, null, p, 'all'); },
    run: (sql, ...p) => { guardSystem(sql); return exec(sql, null, p, 'run'); },
    insert(table, obj) {
      if (isTenantTable(table)) throw new Error(`Unscoped insert on tenant table ${table}`);
      const { sql, args } = buildInsert(table, obj, null);
      prepare(sql).run(...args);
      return obj;
    },
    update(table, id, patch) {
      if (isTenantTable(table)) throw new Error(`Unscoped update on tenant table ${table}`);
      const u = buildUpdate(table, id, patch, null);
      return u ? num(prepare(u.sql).run(...u.args).changes) : 0;
    },
    transaction,
  };

  /** Tenant-scoped facade: every tenant-table query is filtered by tenant_id automatically. */
  function forTenant(tenantId) {
    if (!tenantId || typeof tenantId !== 'string') throw new Error('forTenant requires a tenantId');
    return {
      tenantId,
      get: (sql, ...p) => exec(sql, tenantId, p, 'get'),
      all: (sql, ...p) => exec(sql, tenantId, p, 'all'),
      run: (sql, ...p) => exec(sql, tenantId, p, 'run'),
      insert(table, obj) {
        if (!isTenantTable(table)) throw new Error(`${table} is not a registered tenant table`);
        const { sql, args } = buildInsert(table, obj, tenantId);
        prepare(sql).run(...args);
        return { ...obj, tenant_id: tenantId };
      },
      update(table, id, patch) {
        if (!isTenantTable(table)) throw new Error(`${table} is not a registered tenant table`);
        const u = buildUpdate(table, id, patch, tenantId);
        return u ? num(prepare(u.sql).run(...u.args).changes) : 0;
      },
      transaction,
    };
  }

  /**
   * Run a module's migrations in order (idempotent, tracked in _migrations) and register tenant tables.
   * @param {string} moduleName
   * @param {Array<string|{sql:string,tenantTables?:string[],systemTables?:string[]}>} migrations
   */
  function migrate(moduleName, migrations = []) {
    raw.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    migrations.forEach((m, i) => {
      const mig = typeof m === 'string' ? { sql: m } : m;
      const systemTables = (mig.systemTables ?? []).map((t) => t.toLowerCase());
      const auto = [...mig.sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_]\w*)\s*\(([^;]*)/gi)]
        .filter((mm) => /\btenant_id\b/i.test(mm[2]) && !systemTables.includes(mm[1].toLowerCase()))
        .map((mm) => mm[1]);
      registerTenantTables([...(mig.tenantTables ?? []), ...auto]);
      const id = `${moduleName}:${i}`;
      if (raw.prepare('SELECT 1 FROM _migrations WHERE id = ?').get(id)) return;
      transaction(() => {
        raw.exec(mig.sql);
        raw.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(id, new Date().toISOString());
      });
    });
  }

  return {
    raw,
    system,
    forTenant,
    migrate,
    registerTenantTables,
    isTenantTable,
    tenantTables: () => [...tenantTables],
    /** Prefixed random id, e.g. id('clm') -> 'clm_3f2a...'. */
    id: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
    /** JSON helpers for text columns. */
    toJson: (v) => (v === undefined ? null : JSON.stringify(v)),
    parseJson: (s, fallback = null) => {
      if (s === null || s === undefined || s === '') return fallback;
      try { return JSON.parse(s); } catch { return fallback; }
    },
    close: () => { stmts.clear(); raw.close(); },
  };
}
