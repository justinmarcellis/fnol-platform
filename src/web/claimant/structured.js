// Structured (party / vehicle / address) answer helpers for the claimant app. Pure logic: no DOM, no kit imports.
// ---- structured answers (party / vehicle / address) --------------------------------------------------
// Field names follow Party.schema.json, Vehicle.schema.json and common.schema.json#/$defs/Address. The sub-form
// collects flat string values keyed by `key`; buildStructured turns them into the object the intake API validates.
// `atFault` is not in Party.schema.json yet (contract-change requested); the server passes unmapped fields through.

/** Question types rendered as a structured sub-form. */
export const STRUCTURED_TYPES = ['party', 'vehicle', 'address'];

/** Party roles offered in the sub-form (subset of the Party.roles enum). */
export const PARTY_ROLES = ['third_party', 'driver', 'passenger', 'witness', 'owner'];

const FIELDS = {
  party: [
    { key: 'firstName', input: 'text', required: false, autocomplete: 'off' },
    { key: 'lastName', input: 'text', required: true, autocomplete: 'off' },
    { key: 'role', input: 'select', required: true, options: PARTY_ROLES },
    { key: 'phone', input: 'tel', required: false, autocomplete: 'off' },
    { key: 'insurerName', input: 'text', required: false },
    { key: 'otherPolicyNumber', input: 'text', required: false },
    { key: 'atFault', input: 'checkbox', required: false },
  ],
  vehicle: [
    { key: 'year', input: 'number', required: false },
    { key: 'make', input: 'text', required: false },
    { key: 'model', input: 'text', required: false },
    { key: 'vin', input: 'text', required: false },
    { key: 'licensePlate', input: 'text', required: false },
  ],
  address: [
    { key: 'line1', input: 'text', required: true, autocomplete: 'off' },
    { key: 'city', input: 'text', required: true },
    { key: 'state', input: 'text', required: true },
    { key: 'postalCode', input: 'text', required: true },
  ],
};

/** True for party, vehicle and address questions. */
export function isStructured(q) {
  return STRUCTURED_TYPES.includes(q?.type);
}

/** Field descriptors for a structured type ([] for any other type). */
export function structuredFields(type) {
  return (FIELDS[type] ?? []).map((f) => ({ ...f, ...(f.options ? { options: [...f.options] } : {}) }));
}

const clean = (v) => (typeof v === 'string' ? v.trim() : v);

/**
 * Build the answer object from raw sub-form values (strings, plus a boolean for checkboxes).
 * Empty values are dropped. Party: `role` becomes roles[] (default third_party) with kind 'person'.
 * @param {'party'|'vehicle'|'address'} type
 * @param {Record<string, string|boolean|undefined>} raw
 * @returns {object}
 */
export function buildStructured(type, raw = {}) {
  const r = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, clean(v)]));
  const out = {};
  const put = (k, v) => { if (v !== undefined && v !== null && v !== '') out[k] = v; };
  if (type === 'party') {
    put('firstName', r.firstName); put('lastName', r.lastName);
    out.roles = [PARTY_ROLES.includes(r.role) ? r.role : 'third_party'];
    out.kind = 'person';
    put('phone', r.phone); put('insurerName', r.insurerName); put('otherPolicyNumber', r.otherPolicyNumber);
    if (r.atFault === true || r.atFault === 'true') out.atFault = true;
  } else if (type === 'vehicle') {
    if (r.year !== '' && r.year !== undefined && Number.isInteger(Number(r.year))) out.year = Number(r.year);
    put('make', r.make); put('model', r.model);
    put('vin', typeof r.vin === 'string' ? r.vin.toUpperCase() : r.vin);
    put('licensePlate', r.licensePlate); put('policyVehicleId', r.policyVehicleId);
  } else if (type === 'address') {
    put('line1', r.line1); put('city', r.city);
    put('state', typeof r.state === 'string' ? r.state.toUpperCase() : r.state);
    put('postalCode', r.postalCode);
  }
  return out;
}

/**
 * Client-side completeness check. Returns the keys that are required but empty, so the sub-form can mark them.
 * Party needs a last name and a role; vehicle needs a VIN, or make and model; address needs line1/city/state/postalCode.
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function missingStructured(type, raw = {}) {
  const v = (k) => String(clean(raw[k]) ?? '');
  let missing = [];
  if (type === 'vehicle') {
    if (!v('vin') && !(v('make') && v('model'))) missing = v('make') ? ['model'] : ['vin'];
  } else {
    missing = (FIELDS[type] ?? []).filter((f) => f.required && !v(f.key)).map((f) => f.key);
  }
  return { ok: missing.length === 0, missing };
}

/** The message the server returned for a question in an errors[] list (from a 422 body), or ''. */
export function errorFor(errors, questionId) {
  const e = (Array.isArray(errors) ? errors : []).find((x) => x?.questionId === questionId);
  return e?.message ? String(e.message) : '';
}

// ---- insured vehicle from the policy (GET /intake/sessions/{sessionId}/policy-vehicles)

/** Rows from the policy-vehicles endpoint as picker options: { unitId, label, answer }. Rows without a unitId are skipped. */
export function policyVehicleOptions(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((v) => v && typeof v.unitId === 'string' && v.unitId).map((v) => ({
    unitId: v.unitId,
    label: ([v.year, v.make, v.model].filter(Boolean).join(' ') + (v.vinLast4 ? ` (VIN ...${v.vinLast4})` : '')).trim() || v.unitId,
    answer: buildStructured('vehicle', { year: v.year, make: v.make, model: v.model, policyVehicleId: v.unitId }),
  }));
}

/**
 * Load the session policy's vehicles through GET /intake/sessions/{sessionId}/policy-vehicles?lastName=&zip= (S5-WFL-04
 * holder check: last name of a named insured + 5-digit ZIP on the policy). Any failure (uniform 404, network) yields [] so
 * the picker stays hidden. Names and ZIPs are sent only as query parameters and never stored or logged.
 * @param {{ get: (path: string, query?: object) => Promise<any> }} api
 * @param {string} sessionId
 * @param {{ lastName?: string, zip?: string }} [holder]
 */
export async function fetchPolicyVehicles(api, sessionId, holder = {}) {
  if (!sessionId) return [];
  const lastName = holder.lastName === undefined ? undefined : String(holder.lastName).trim();
  const zip = holder.zip === undefined ? undefined : String(holder.zip).trim();
  try {
    return policyVehicleOptions(await api.get(`/intake/sessions/${encodeURIComponent(sessionId)}/policy-vehicles`, { lastName, zip }));
  } catch {
    return [];
  }
}

/**
 * Holder check with a result the UI can explain (CLAIMANT-6): `{ ok: true, vehicles }` when the holder matched, even
 * when the policy has no vehicles (200 []); `{ ok: false, reason: 'not_matched' }` for the uniform 404 (unknown policy,
 * wrong name or ZIP, locked); `{ ok: false, reason: 'unavailable' }` for network or server failures.
 * @param {{ get: (path: string, query?: object) => Promise<any> }} api
 * @param {string} sessionId
 * @param {{ lastName?: string, zip?: string }} [holder]
 */
export async function checkPolicyHolder(api, sessionId, holder = {}) {
  if (!sessionId) return { ok: false, reason: 'not_matched' };
  const lastName = String(holder.lastName ?? '').trim();
  const zip = String(holder.zip ?? '').trim();
  try {
    const rows = await api.get(`/intake/sessions/${encodeURIComponent(sessionId)}/policy-vehicles`, { lastName, zip });
    return { ok: true, vehicles: policyVehicleOptions(rows) };
  } catch (err) {
    return { ok: false, reason: err?.status === 404 && err?.code !== 'service_unavailable' ? 'not_matched' : 'unavailable' };
  }
}

/** Question id of the shipped tenants' insured-vehicle question. */
export const INSURED_VEHICLE_QUESTION = 'insured_vehicle';
