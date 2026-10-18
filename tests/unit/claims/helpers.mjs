import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createApp } from '../../../src/server.mjs';
import { createClock } from '../../../src/core/clock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const claimsEntry = pathToFileURL(path.resolve(here, '../../../src/modules/claims/index.mjs')).href;

export const T0 = '2026-03-02T15:00:00.000Z'; // a Monday

/** Illustrative timer config (synthetic, not legal advice). */
export const timers = [
  {
    id: 'WI-ACK', state: 'WI', kind: 'acknowledge', duration: { value: 7, unit: 'days' }, startOn: 'claim.reported',
    lobs: ['personal_auto', 'homeowners'], stopOn: { event: 'claim.status.changed', toStatus: ['assigned', 'fast_tracked'] },
    warnBefore: { value: 2, unit: 'days' },
    onBreach: [
      { type: 'add_flag', flag: 'ack_breach' }, { type: 'notify', template: 'timer_breach_internal' },
      { type: 'add_task', task: { type: 'timer_breach_followup', title: 'Resolve breached deadline', dueInHours: 8, queue: 'auto_physical_damage' } },
      { type: 'route_queue', queue: 'escalations' },
    ],
    citation: 'Illustrative WI acknowledgement deadline',
  },
  {
    id: 'WI-CONTACT', state: 'WI', kind: 'contact', duration: { value: 3, unit: 'business_days' }, startOn: 'claim.reported',
    stopOn: { taskType: 'contact_insured' }, warnBefore: { value: 1, unit: 'business_days' }, onBreach: [{ type: 'add_flag', flag: 'contact_breach' }],
  },
  { id: 'IL-ACK', state: 'IL', kind: 'acknowledge', duration: { value: 24, unit: 'hours' }, startOn: 'claim.reported', stopOn: { taskType: 'acknowledge_claimant' } },
  {
    id: 'WI-DECIDE', state: 'WI', kind: 'decide', duration: { value: 30, unit: 'days' }, startOn: 'claim.coverage.verified',
    stopOn: { event: 'claim.triaged' },
  },
];

/** Boot an isolated app with the real claims module. Tenants: alpha (timers, holidays), beta (none). */
export async function bootClaimsApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-claims-'));
  const modulesDir = path.join(dir, 'modules', 'claims');
  fs.mkdirSync(modulesDir, { recursive: true });
  fs.writeFileSync(path.join(modulesDir, 'index.mjs'), `export { default } from '${claimsEntry}';\n`);
  const tenantsDir = path.join(dir, 'tenants');
  fs.mkdirSync(tenantsDir);
  const tenants = {
    alpha: { id: 'alpha', displayName: 'Alpha Mutual', claimNumberPrefix: 'ALP', holidays: ['2026-03-05'], timers },
    beta: { id: 'beta', displayName: 'Beta Casualty', claimNumberPrefix: 'BET', timers: [] },
  };
  for (const [id, cfg] of Object.entries(tenants)) fs.writeFileSync(path.join(tenantsDir, `${id}.json`), JSON.stringify(cfg));
  const clock = createClock({ fixed: T0 });
  const app = await createApp({
    dbPath: ':memory:', port: 0, secretsDir: path.join(dir, 'secrets'), tenantsDir, modulesDir: path.join(dir, 'modules'), logLevel: 'silent', clock,
  });
  const close = app.close;
  app.close = async () => { await app.ctx.bus.drain(); await close(); fs.rmSync(dir, { recursive: true, force: true }); };
  app.clock = clock;
  app.token = (roles, tenantId = 'alpha', sub = 'u1') => app.ctx.auth.issueToken({ sub, tenantId, roles });
  app.claims = (tenantId = 'alpha') => app.ctx.forTenant(tenantId).modules.claims;
  app.tctx = (tenantId = 'alpha') => app.ctx.forTenant(tenantId);
  /** Publish a fact event as another module would, and wait for handlers. */
  app.emit = async (type, claimId, data, tenantId = 'alpha') => {
    const evt = app.ctx.bus.publish(tenantId, type, claimId, { claimId, ...data });
    await app.ctx.bus.drain();
    return evt;
  };
  return app;
}

export const SYSTEM = { type: 'system', id: 'test', role: 'system' };
export const user = (role, id = 'u1') => ({ type: 'user', id, role, roles: [role] });

/** Synthetic claim input. */
export function claimInput(over = {}) {
  return {
    lob: 'personal_auto', lossType: 'auto_collision', channel: 'api', policyNumber: 'POL-100200', riskState: 'WI',
    lossEvent: {
      lossDate: '2026-02-28', cause: 'collision', description: 'Zelda Quartz rear-ended at the Birch Street light, no one hurt',
      injuriesReported: false, vehiclesInvolved: 2,
      location: { description: 'Birch St and 4th', address: { line1: '14 Birch Street', city: 'Madison', state: 'WI', postalCode: '53703' } },
    },
    parties: [
      { roles: ['insured', 'driver'], kind: 'person', firstName: 'Zelda', lastName: 'Quartz', phone: '+1 608 555 0142', email: 'zelda.quartz@example.test',
        dateOfBirth: '1985-04-12', address: { line1: '14 Birch Street', city: 'Madison', state: 'WI', postalCode: '53703' },
        driversLicense: { number: 'Q123-4567-8901', state: 'WI' }, injuryDescription: 'sore neck' },
    ],
    vehicles: [{ role: 'insured', vin: '1HGBH41JXMN109186', make: 'Testa', model: 'Alpha', licensePlate: 'ZQ-4471', plateState: 'WI' }],
    ...over,
  };
}

export async function call(app, method, url, { token, body, headers } = {}) {
  const res = await fetch(app.url + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
