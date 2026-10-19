// Who is using the desk (CSR or agent) and what the server lets that role read. Pure logic: no kit imports, no DOM.
import { CSR_CHANNEL } from './assisted.js';

/** Contract channel for agent-assisted intake (common.schema.json Channel enum). */
export const AGENT_CHANNEL = 'agent_portal';

/**
 * What the API currently allows the `agent` role to read (S6-BUG-02). The server answers 403/404 for these today
 * (coverage snapshot is csr/adjuster/supervisor/integration only, policy-vehicles needs a produced policy and seeded
 * policies carry no producer, GET /claims excludes agent). Requests are posted to the integration hub; flip a flag
 * once the server allows it and the desk uses the call again. The CSR (and any other desk role) may read all of them.
 */
export const AGENT_ACCESS = Object.freeze({ policySnapshot: false, policyVehicles: false, recentClaims: false, claimView: false });
const FULL_ACCESS = Object.freeze({ policySnapshot: true, policyVehicles: true, recentClaims: true, claimView: true });

/** Roles field of a JWT payload without verifying it (display only; the server enforces). Never throws. */
export function tokenRoles(token) {
  try {
    const part = String(token ?? '').split('.')[1];
    if (!part) return [];
    const json = typeof atob === 'function'
      ? atob(part.replace(/-/g, '+').replace(/_/g, '/'))
      : Buffer.from(part, 'base64url').toString('utf8');
    const roles = JSON.parse(json)?.roles;
    return Array.isArray(roles) ? roles.filter((r) => typeof r === 'string') : [];
  } catch { return []; }
}

/**
 * The desk role: 'agent' or 'csr'. The demo session's persona wins, then the token's roles. Unknown -> 'csr'.
 * @param {{ persona?: { role?: string } } | null} session
 * @param {string|null} token
 */
export function deskRole(session, token) {
  const fromPersona = session?.persona?.role;
  if (fromPersona === 'agent' || fromPersona === 'csr') return fromPersona;
  const roles = tokenRoles(token);
  if (roles.includes('csr')) return 'csr';
  if (roles.includes('agent')) return 'agent';
  return 'csr';
}

/** Read access for the desk role. */
export function deskAccess(role) {
  return role === 'agent' ? AGENT_ACCESS : FULL_ACCESS;
}

/**
 * Intake channel for the role and line of business: agents use agent_portal where the tenant enables it for the line
 * (GET /config/public lobs[].channels), otherwise csr_phone.
 * @param {string} role
 * @param {{ id: string, channels?: string[] }[]} lobs
 * @param {string} lob
 */
export function channelFor(role, lobs, lob) {
  if (role !== 'agent') return CSR_CHANNEL;
  const cfg = (Array.isArray(lobs) ? lobs : []).find((l) => l?.id === lob);
  return Array.isArray(cfg?.channels) && cfg.channels.includes(AGENT_CHANNEL) ? AGENT_CHANNEL : CSR_CHANNEL;
}

/** String keys for the role-specific labels (header role, page heading, title). */
export function roleKeys(role) {
  const r = role === 'agent' ? 'agent' : 'csr';
  return { role: `csr.role.${r}`, heading: `csr.heading.${r}`, title: `csr.title.${r}` };
}

/** Short code per line of business as used at the start of the tenant's policy numbers (HO-IL-1030185). */
const LOB_CODES = { personal_auto: 'PA', homeowners: 'HO', commercial_auto: 'CA', renters: 'RE', condo: 'CO', commercial_property: 'CP' };
const lobCode = (id) => LOB_CODES[id] ?? String(id ?? '').split(/[_\s-]+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 3);

/**
 * Example policy-number prefixes for the search hint, from the tenant's lines and states, e.g. ['PA-WI', 'HO-WI'].
 * @param {{ id: string, enabled?: boolean, states?: string[] }[]} lobs
 */
export function policyExamples(lobs) {
  const out = [];
  for (const l of Array.isArray(lobs) ? lobs : []) {
    if (!l?.id || l.enabled === false) continue;
    const code = lobCode(l.id);
    const st = Array.isArray(l.states) && l.states[0] ? String(l.states[0]).toUpperCase() : '';
    if (code) out.push(st ? `${code}-${st}` : code);
  }
  return [...new Set(out)].slice(0, 3);
}
