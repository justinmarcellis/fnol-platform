// Mock policy admin system. Stores synthetic PolicySnapshot docs per tenant in
// coverage_policies. PII (insured and driver names, phones, addresses, garaging
// postal codes) is encrypted with ctx.crypto.encryptPii; searching uses blind
// indexes from ctx.crypto.hmacIndex.

import { summarizePolicy } from '../summarize.mjs';
import { nameKeys, normName } from '../names.mjs';

/** Most rows a search returns; the true total is reported alongside (CSR-7). */
export const SEARCH_LIMIT = 50;

const digits = (v) => String(v ?? '').replace(/\D/g, '');
const norm = {
  lastName: (v) => normName(v),
  postalCode: (v) => String(v ?? '').trim().slice(0, 5),
  vin: (v) => String(v ?? '').trim().toUpperCase(),
  phone: (v) => digits(v).slice(-10),
};

/** ",h1,h2," list so a single hash can be matched with LIKE '%,h,%'. */
const packIdx = (hashes) => {
  const u = [...new Set(hashes.filter(Boolean))];
  return u.length ? `,${u.join(',')},` : null;
};

/**
 * Derive the status of a stored policy as of a date.
 * @param {object} doc stored policy
 * @param {string} asOf YYYY-MM-DD
 */
export function statusAsOf(doc, asOf) {
  const { effectiveDate, expirationDate, cancellationDate } = doc.period;
  if (doc.status === 'not_found') return 'not_found';
  if (cancellationDate && asOf >= cancellationDate) return 'cancelled';
  if (asOf >= expirationDate) return 'expired';
  if (doc.status === 'pending_cancellation') return 'pending_cancellation';
  // Before the effective date the status is still in_force; the rule function reports it as outside the term.
  return 'in_force';
}

/** Split PII out of a policy doc. Returns the sanitized doc and the PII bundle. */
function splitPii(p) {
  const doc = JSON.parse(JSON.stringify(p));
  const pii = { insureds: doc.namedInsureds ?? [], drivers: (doc.drivers ?? []).map((d) => d.name ?? null), garaging: {}, addresses: {} };
  delete doc.namedInsureds;
  doc.drivers = (doc.drivers ?? []).map((d) => ({ ...d, name: undefined }));
  for (const v of doc.vehicles ?? []) {
    if (v.garagingPostalCode) { pii.garaging[v.unitId] = v.garagingPostalCode; delete v.garagingPostalCode; }
  }
  for (const pr of doc.properties ?? []) {
    if (pr.address) { pii.addresses[pr.locationId] = pr.address; delete pr.address; }
  }
  return { doc, pii };
}

function joinPii(doc, pii) {
  const out = { ...doc };
  if (pii) {
    out.namedInsureds = pii.insureds.map((i) => ({ name: i.name, relation: i.relation, ...(i.kind ? { kind: i.kind } : {}) }));
    out.drivers = (doc.drivers ?? []).map((d, i) => (pii.drivers[i] ? { ...d, name: pii.drivers[i] } : d));
    out.vehicles = (doc.vehicles ?? []).map((v) => (pii.garaging[v.unitId] ? { ...v, garagingPostalCode: pii.garaging[v.unitId] } : v));
    out.properties = (doc.properties ?? []).map((p) => (pii.addresses[p.locationId] ? { ...p, address: pii.addresses[p.locationId] } : p));
  }
  return out;
}

/**
 * @param {object} ctx tenant-bound context
 */
export function createMockPas(ctx) {
  const readPii = (row) => (row.pii ? JSON.parse(ctx.crypto.decryptPii(row.pii)) : null);

  /**
   * Blind-index lookup (AND semantics). policyNumberPrefix and vinSuffix are not PII: plain, escaped matches on
   * the policy number and on the stored (PII-free) doc. producerId restricts rows to one producer's book.
   * @returns {{ rows: object[], total: number }}
   */
  function queryRows(criteria, { limit = SEARCH_LIMIT } = {}) {
    const where = [];
    const args = [];
    const add = (col, key) => {
      if (criteria[key] === undefined || criteria[key] === null || criteria[key] === '') return;
      where.push(`${col} LIKE ?`);
      args.push(`%,${ctx.crypto.hmacIndex(norm[key](criteria[key]))},%`);
    };
    add('last_name_idx', 'lastName');
    add('postal_idx', 'postalCode');
    add('vin_idx', 'vin');
    add('phone_idx', 'phone');
    const prefix = String(criteria.policyNumberPrefix ?? '').trim();
    if (prefix) {
      where.push("policy_number LIKE ? ESCAPE '\\'");
      args.push(`${prefix.replace(/[\\%_]/g, '\\$&')}%`);
    }
    const suffix = String(criteria.vinSuffix ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (suffix) {
      where.push('doc LIKE ?');
      args.push(`%"vin":"%${suffix}"%`);
    }
    if (!where.length) return { rows: [], total: 0 };
    if (criteria.producerId) {
      where.push("json_extract(doc, '$.producer.agentId') = ?");
      args.push(String(criteria.producerId));
    }
    const sqlWhere = where.join(' AND ');
    const total = ctx.db.get(`SELECT COUNT(*) AS n FROM coverage_policies WHERE ${sqlWhere}`, ...args)?.n ?? 0;
    const rows = ctx.db.all(`SELECT * FROM coverage_policies WHERE ${sqlWhere} ORDER BY policy_number LIMIT ?`, ...args, limit);
    return { rows, total };
  }

  return {
    id: 'mock-pas',

    async getPolicy({ policyNumber, asOf }) {
      const row = ctx.db.get('SELECT * FROM coverage_policies WHERE policy_number = ?', policyNumber);
      if (!row) return null;
      const stored = JSON.parse(row.doc);
      const doc = joinPii(stored, readPii(row));
      const date = asOf ?? ctx.clock.nowIso().slice(0, 10);
      return {
        ...doc,
        tenantId: ctx.tenant.id,
        status: statusAsOf(stored, date),
        asOfDate: date,
        sourceSystem: 'mock-pas',
      };
    },

    async search(criteria = {}) {
      return queryRows(criteria).rows.map((row) => {
        const doc = JSON.parse(row.doc);
        const pii = readPii(row);
        return {
          policyNumber: row.policy_number,
          lob: row.lob,
          status: doc.status,
          period: doc.period,
          namedInsureds: (pii?.insureds ?? []).map((i) => ({ name: i.name })),
          vehicleCount: (doc.vehicles ?? []).length,
          propertyCount: (doc.properties ?? []).length,
        };
      });
    },

    /** Same lookup as search(), returning masked PolicySummary rows (see summarize.mjs). */
    async searchSummaries(criteria = {}) {
      return queryRows(criteria).rows.map((row) => summarizePolicy(JSON.parse(row.doc), readPii(row)));
    },

    /** searchSummaries plus the true number of matches, so callers can say "showing 50 of N". */
    async searchPage(criteria = {}) {
      const { rows, total } = queryRows(criteria);
      return { items: rows.map((row) => summarizePolicy(JSON.parse(row.doc), readPii(row))), total, limit: SEARCH_LIMIT };
    },

    /** Policy numbers a producer writes (not PII), for agent-scoped reads. */
    async producedPolicyNumbers(agentId) {
      if (!agentId) return [];
      return ctx.db.all("SELECT policy_number FROM coverage_policies WHERE json_extract(doc, '$.producer.agentId') = ? ORDER BY policy_number", String(agentId))
        .map((r) => r.policy_number);
    },

    /** Insert or replace synthetic policies for this tenant. Returns { inserted }. */
    async seed(policies) {
      let inserted = 0;
      ctx.db.transaction(() => {
        for (const p of policies) {
          if (!p?.policyNumber || !p.lob || !p.period) throw new ctx.AppError('bad_request', 'policy needs policyNumber, lob and period', 400);
          const { doc, pii } = splitPii(p);
          const idx = (fn) => packIdx(fn().map((v) => (v ? ctx.crypto.hmacIndex(v) : null)));
          const insureds = pii.insureds;
          const row = {
            policy_number: p.policyNumber,
            lob: p.lob,
            doc,
            pii: ctx.crypto.encryptPii(JSON.stringify(pii)),
            last_name_idx: idx(() => insureds.flatMap((i) => nameKeys(i))),
            postal_idx: idx(() => [
              ...Object.values(pii.garaging).map(norm.postalCode),
              ...Object.values(pii.addresses).map((a) => norm.postalCode(a.postalCode)),
            ]),
            vin_idx: idx(() => (doc.vehicles ?? []).map((v) => (v.vin ? norm.vin(v.vin) : null))),
            phone_idx: idx(() => insureds.map((i) => (i.phone ? norm.phone(i.phone) : null))),
          };
          ctx.db.run('DELETE FROM coverage_policies WHERE policy_number = ?', p.policyNumber);
          ctx.db.insert('coverage_policies', row);
          inserted += 1;
        }
      });
      return { inserted };
    },
  };
}
