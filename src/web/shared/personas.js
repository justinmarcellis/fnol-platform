// Demo persona helpers shared by <fx-demo-bar> and the apps. Pure logic, no DOM; safe to import in node.
// Tokens live in sessionStorage only (per tab). The server directory (GET /api/v1/dev/personas) never carries tokens.
import { devLogin } from './devlogin.js';

export const SESSION_KEY = 'fnol.demo.session';
export const PERSONAS_PATH = '/dev/personas';
/** App path -> sessionStorage key the existing apps already read their token from. */
export const APP_TOKEN_KEYS = { '/csr': 'csr.token', '/adjuster': 'adjuster.token', '/admin': 'admin.token' };

/** Display order and labels for the grouped persona dropdown. */
export const APP_GROUPS = [
  { app: '/', label: 'Claimant app' },
  { app: '/csr', label: 'CSR and agent app' },
  { app: '/adjuster', label: 'Adjuster workbench' },
  { app: '/admin', label: 'Administration' },
];

export const ROLE_LABELS = {
  claimant: 'Claimant', csr: 'CSR', agent: 'Agent', adjuster: 'Adjuster', supervisor: 'Supervisor', carrier_admin: 'Carrier admin',
};

const storageOf = (s) => s ?? (typeof sessionStorage !== 'undefined' ? sessionStorage : null);

/** Group a persona list by app, in APP_GROUPS order, skipping empty groups. */
export function groupPersonas(personas = []) {
  return APP_GROUPS
    .map((g) => ({ ...g, personas: personas.filter((p) => (p.app ?? '/') === g.app) }))
    .filter((g) => g.personas.length);
}

/** Where to navigate after choosing a persona. */
export function personaTarget(persona, tenantId) {
  if (persona.role === 'claimant') return `/?tenant=${encodeURIComponent(tenantId ?? persona.tenantId ?? '')}`;
  return persona.path ?? persona.app ?? '/';
}

/** Read the stored demo session, or null. */
export function readSession(storage) {
  try {
    const raw = storageOf(storage)?.getItem(SESSION_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return s && s.token && s.persona ? s : null;
  } catch { return null; }
}

/** Remove the demo session and every app token it wrote. */
export function clearSession(storage) {
  const st = storageOf(storage);
  if (!st) return;
  try {
    st.removeItem(SESSION_KEY);
    for (const k of Object.values(APP_TOKEN_KEYS)) st.removeItem(k);
    st.removeItem('admin.who');
  } catch { /* storage may be blocked */ }
}

/** Store a session for this tab and mirror the token to the target app's own key so the app signs in on load. */
export function saveSession(storage, { token, tenantId, persona }) {
  const st = storageOf(storage);
  if (!st) return false;
  try {
    clearSession(st);
    st.setItem(SESSION_KEY, JSON.stringify({ token, tenantId, persona }));
    const key = APP_TOKEN_KEYS[persona.app];
    if (key) st.setItem(key, token);
    if (persona.app === '/admin') st.setItem('admin.who', `${persona.displayName} (${tenantId})`);
    return true;
  } catch { return false; }
}

/**
 * For apps: the demo token for this tab when the stored persona belongs to the app, else null.
 * @param {string} appPath '/', '/csr', '/adjuster' or '/admin'
 */
export function consumePersonaToken(appPath, storage) {
  const s = readSession(storage);
  if (!s) return null;
  return s.persona.app === appPath ? { token: s.token, tenantId: s.tenantId, persona: s.persona } : null;
}

/** Claimant holder-check hint (policy number, last name, ZIP) from the stored claimant persona, or null. */
export function claimantHint(storage) {
  const s = readSession(storage);
  return s?.persona?.role === 'claimant' && s.persona.hint ? s.persona.hint : null;
}

/**
 * Load the persona directory.
 * @param {{get:Function}} api shared api client (baseUrl /api/v1)
 * @returns {Promise<{tenants:Array}>}
 */
export async function loadPersonas(api) {
  const r = await api.get(PERSONAS_PATH);
  return { tenants: Array.isArray(r?.tenants) ? r.tenants : [] };
}

/**
 * Mint a token for the persona (POST /auth/token), store it for the tab and return the target URL.
 * @returns {Promise<{url:string, token:string}>}
 */
export async function switchPersona(api, { tenantId, persona, storage }, opts = {}) {
  const res = await devLogin(api, {
    tenant: tenantId, role: persona.role, roles: persona.roles, userId: persona.userId, name: persona.displayName,
  }, { dev: opts.dev ?? true });
  const token = res?.token;
  if (!token) throw new Error('No token returned');
  saveSession(storage, { token, tenantId, persona });
  return { url: personaTarget(persona, tenantId), token };
}
