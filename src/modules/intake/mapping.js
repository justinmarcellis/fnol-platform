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
