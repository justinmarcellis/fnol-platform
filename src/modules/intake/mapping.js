// Map intake answers to a ClaimCreate document using each question's `mapsTo` path.
//   loss.<field> | lossEvent.<field>        -> lossEvent[field]
//   lossType | policyNumber | riskState      -> top-level
//   parties[role=driver].phone               -> parties entry whose roles include `driver`
//   vehicles[role=insured].drivable          -> vehicles entry with role `insured`
//   properties[role=insured_location].x      -> properties entry
// Unmapped `party`/`vehicle` questions contribute whole entries. Unmapped scalars stay on the session
// (rules read them as facts.answers).

const PATH_RE = /^(parties|vehicles|properties)\[role=([a-z_]+)\]\.([A-Za-z][\w.]*)$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

function setDeep(obj, dotted, value) {
  const keys = dotted.split('.');
  if (keys.some((k) => FORBIDDEN.has(k))) return;
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys.at(-1)] = value;
}

function entryFor(list, key, role) {
  let e = list.find((x) => x.__k === `${key}:${role}`);
  if (!e) {
    e = key === 'parties' ? { __k: `${key}:${role}`, roles: [role], kind: 'person' } : { __k: `${key}:${role}`, role };
    list.push(e);
  }
  return e;
}

const strip = (list) => list.map(({ __k, ...rest }) => rest); // eslint-disable-line no-unused-vars

/**
 * @param {{ lob: string, lossType?: string, channel: string, policyNumber?: string, id: string }} session
 * @param {object} answers questionId -> { value }
 * @param {object[]} questions visible questions (hidden answers are ignored)
 * @param {object} lossTypeCauses config lob lossTypes (for the cause fallback)
 * @returns {{ input: object, missing: string[] }}
 */
export function toClaimCreate(session, answers, questions, lobConfig) {
  const input = { lob: session.lob, channel: session.channel, intakeSessionId: session.id, lossEvent: {} };
  if (session.lossType) input.lossType = session.lossType;
  if (session.policyNumber) input.policyNumber = session.policyNumber;
  const lists = { parties: [], vehicles: [], properties: [] };
  const fieldProvenance = {};

  for (const q of questions) {
    const a = answers[q.id];
    if (!a || a.value === undefined || a.value === null || a.value === '') continue;
    if (q.type === 'disclosure' || q.type === 'media') continue;
    const target = String(q.mapsTo ?? '');
    const m = PATH_RE.exec(target);
    if (m) {
      const [, key, role, field] = m;
      setDeep(entryFor(lists[key], key, role), field, a.value);
    } else if (/^(loss|lossEvent)\./.test(target)) {
      const field = target.replace(/^(loss|lossEvent)\./, '');
      setDeep(input.lossEvent, field, a.value);
      if (a.provenance?.source) fieldProvenance[field.split('.')[0]] = a.provenance;
    } else if (target === 'lossType' || target === 'policyNumber' || target === 'riskState') {
      input[target] = a.value;
    } else if (q.type === 'party' && a.value && typeof a.value === 'object') {
      const roles = Array.isArray(a.value.roles) && a.value.roles.length ? a.value.roles : ['third_party'];
      const { roles: _r, ...rest } = a.value; // eslint-disable-line no-unused-vars
      lists.parties.push({ roles, kind: 'person', ...rest });
    } else if (q.type === 'vehicle' && a.value && typeof a.value === 'object') {
      lists.vehicles.push({ role: 'insured', ...a.value });
    }
  }

  const ev = input.lossEvent;
  if (!input.riskState) input.riskState = ev.location?.state ?? undefined;
  if (input.riskState === undefined) delete input.riskState;
  if (!ev.cause) {
    const lt = (lobConfig?.lossTypes ?? []).find((t) => t.id === input.lossType);
    ev.cause = lt?.causes?.[0] ?? 'other';
  }
  if (ev.description === undefined) ev.description = '(no narrative provided)';
  if (Object.keys(fieldProvenance).length) ev.fieldProvenance = fieldProvenance;
  for (const [k, list] of Object.entries(lists)) if (list.length) input[k] = strip(list);

  const missing = [];
  if (!ev.lossDate) missing.push('lossEvent.lossDate');
  return { input, missing };
}

// ---------------------------------------------------------------------------------------------------------
// Enrichment from the policy snapshot (S4-WFL-01). toClaimCreate stays synchronous and pure; the async
// step below adds what only the policy system knows (insured vehicle / insured location identity) so
// coverage verification can match the claim to a policy unit.

const norm = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().toUpperCase() : '');
const isAutoLob = (lob) => /auto/.test(String(lob ?? ''));
const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

function setMeta(out, meta) {
  Object.defineProperty(out, 'enrichment', { value: meta, enumerable: false, configurable: true });
  return out;
}

/** VIN / unit identifiers the claimant or CSR supplied, from the mapped insured vehicle entry and from answers. */
function vehicleIds(input, answers, questions) {
  const vins = new Set();
  const units = new Set();
  const take = (o) => {
    if (!o) return;
    if (norm(o.vin)) vins.add(norm(o.vin));
    for (const k of ['unit', 'unitId', 'policyVehicleId']) if (norm(o[k])) units.add(norm(o[k]));
  };
  for (const v of input.vehicles ?? []) if (!v.role || v.role === 'insured') take(v);
  for (const q of questions ?? []) {
    const a = answers?.[q.id];
    if (!a || a.value === undefined || a.value === null || a.value === '') continue;
    if (q.type === 'disclosure' || q.type === 'media') continue;
    const o = asObj(a.value);
    if (o) { if (q.type === 'vehicle' || /^vehicles\[/.test(String(q.mapsTo ?? ''))) take(o); continue; }
    if (typeof a.value !== 'string' && typeof a.value !== 'number') continue;
    const target = String(q.mapsTo ?? '');
    if (/\.vin$/.test(target) || q.id === 'vin') vins.add(norm(a.value));
    else if (/\.(unit|unitId)$/.test(target) || q.id === 'unit' || q.id === 'unit_id') units.add(norm(a.value));
    else if (q.type === 'vehicle') { vins.add(norm(a.value)); units.add(norm(a.value)); }
  }
  return { vins, units, any: vins.size + units.size > 0 };
}

function pickVehicle(snapshot, ids) {
  const list = Array.isArray(snapshot.vehicles) ? snapshot.vehicles : [];
  // A picked unit id (insured_vehicle picker) wins over a VIN that may have been typed or prefilled.
  if (ids.units.size) {
    const byUnit = list.find((pv) => norm(pv.unitId) && ids.units.has(norm(pv.unitId)));
    if (byUnit) return byUnit;
  }
  if (ids.any) return list.find((pv) => (norm(pv.vin) && ids.vins.has(norm(pv.vin))) || (norm(pv.unitId) && ids.units.has(norm(pv.unitId)))) ?? null;
  return list.length === 1 ? list[0] : null; // no identifier given: a single-vehicle policy identifies itself
}

function applyVehicle(out, pv, picked = false) {
  const vehicles = out.vehicles ?? [];
  let entry = vehicles.find((v) => !v.role || v.role === 'insured');
  if (!entry) { entry = { role: 'insured' }; vehicles.push(entry); }
  entry.role = 'insured';
  if (pv.vin) entry.vin = pv.vin;
  for (const k of ['year', 'make', 'model']) if ((picked || entry[k] === undefined) && pv[k] !== undefined) entry[k] = pv[k]; // a picked unit's policy data wins
  entry.policyVehicleId = pv.unitId;
  out.vehicles = vehicles;
}

function pickLocation(snapshot, entry) {
  const list = Array.isArray(snapshot.properties) ? snapshot.properties : [];
  const id = norm(entry?.policyLocationId);
  if (id) return list.find((l) => norm(l.locationId) === id) ?? null;
  const zip = norm(entry?.address?.postalCode);
  const line1 = norm(entry?.address?.line1);
  if (line1 || zip) {
    const hit = list.filter((l) => (line1 && norm(l.address?.line1) === line1) || (!line1 && zip && norm(l.address?.postalCode) === zip));
    if (hit.length === 1) return hit[0];
    return null;
  }
  return list.length === 1 ? list[0] : null;
}

function applyProperty(out, loc) {
  const properties = out.properties ?? [];
  let entry = properties.find((p) => !p.role || p.role === 'insured_location');
  if (!entry) { entry = { role: 'insured_location' }; properties.push(entry); }
  entry.role = 'insured_location';
  entry.policyLocationId = loc.locationId;
  if (entry.address === undefined && loc.address) entry.address = structuredClone(loc.address);
  if (entry.dwellingType === undefined && loc.dwellingType) entry.dwellingType = loc.dwellingType;
  out.properties = properties;
}

/**
 * Add policy number and the matched insured vehicle / insured location to a ClaimCreate. Never throws.
 * Policy number: an answer mapped to policyNumber, else session.policyNumber. Vehicle: matched by VIN
 * (case-insensitive) or unit id against snapshot.vehicles; with no identifier a single-vehicle policy is used.
 * Property LOBs: the matched snapshot location becomes properties[role=insured_location]. When there is no
 * policy number, no snapshot, or no match, the input is returned unchanged. The returned object carries a
 * non-enumerable `enrichment` = { policyNumber, vehicle|property: 'matched'|'unmatched'|'skipped' }.
 * @param {object} input ClaimCreate from toClaimCreate
 * @param {{ session?: object, answers?: object, questions?: object[], getSnapshot?: (policyNumber: string, asOf?: string) => Promise<object|null>|object|null }} deps
 */
export async function enrichClaimCreate(input, { session, answers, questions, getSnapshot } = {}) {
  const meta = { policyNumber: false, vehicle: 'skipped', property: 'skipped' };
  try {
    if (!input || typeof input !== 'object') return input;
    const out = structuredClone(input);
    const fromAnswer = (questions ?? [])
      .filter((q) => q.mapsTo === 'policyNumber')
      .map((q) => answers?.[q.id]?.value)
      .find((v) => typeof v === 'string' && v.trim());
    const policyNumber = (fromAnswer ?? out.policyNumber ?? session?.policyNumber ?? '').toString().trim();
    if (!policyNumber) return setMeta(out, meta);
    out.policyNumber = policyNumber;
    meta.policyNumber = true;
    if (typeof getSnapshot !== 'function') return setMeta(out, meta);

    let snapshot = null;
    try { snapshot = await getSnapshot(policyNumber, out.lossEvent?.lossDate); } catch { snapshot = null; } // lookup failure is not an intake failure
    if (!snapshot || typeof snapshot !== 'object') return setMeta(out, meta);

    if (isAutoLob(out.lob) || (!out.lob && Array.isArray(snapshot.vehicles))) {
      const ids = vehicleIds(out, answers, questions);
      const pv = pickVehicle(snapshot, ids);
      if (pv) { applyVehicle(out, pv, ids.units.has(norm(pv.unitId))); meta.vehicle = 'matched'; } else meta.vehicle = 'unmatched';
    } else {
      const entry = (out.properties ?? []).find((p) => !p.role || p.role === 'insured_location');
      const loc = pickLocation(snapshot, entry);
      if (loc) { applyProperty(out, loc); meta.property = 'matched'; } else meta.property = 'unmatched';
    }
    return setMeta(out, meta);
  } catch {
    return input; // never throw; nothing from answers or the snapshot is logged
  }
}
