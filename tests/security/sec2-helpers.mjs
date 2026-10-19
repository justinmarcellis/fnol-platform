// Helpers for the Sprint 2 security review tests (S2-SEC-01). Reuses helpers.mjs; adds a boot with the two
// synthetic seed tenants (full TenantConfig: question sets, queues, claims port) so module flows really run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootSecurityApp, call, ROOT, PII } from './helpers.mjs';

export { call, PII, ROOT };
export const T1 = 'aurelia-mutual';
export const T2 = 'kestrel-point';

/** Boot the platform with copies of the seed tenants. `app.close()` also removes the copy. */
export async function bootReal(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-sec2-ten-'));
  for (const f of ['aurelia-mutual.json', 'kestrel-point.json']) fs.copyFileSync(path.join(ROOT, 'tenants', f), path.join(dir, f));
  const app = await bootSecurityApp({ tenantsDir: dir, ...extra });
  const close = app.close;
  app.close = async () => { try { await close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };
  app.as = (tenant, roles, sub) => app.tokenFor(tenant, roles, sub);
  return app;
}

/** A claim with synthetic PII, created by a CSR in `tenant`. Returns the claim id. */
export async function createClaimWithPii(app, tenant, who = 'A', { policyNumber = 'AUR-00000001' } = {}) {
  const p = PII[who];
  const [first, last] = p.fullName.split(' ');
  const r = await call(app, 'POST', '/api/v1/claims', {
    token: app.as(tenant, ['csr'], 'sec2-csr'),
    body: {
      lob: 'personal_auto', channel: 'csr_phone', policyNumber,
      lossEvent: { lossDate: '2026-10-01', cause: 'collision', description: `${p.fullName} reports a collision at ${p.address}`, injuriesReported: false },
      parties: [{ roles: ['insured'], kind: 'person', firstName: first, lastName: last, phone: p.phone, email: p.email, dateOfBirth: p.dob }],
    },
  });
  if (r.status !== 201) throw new Error(`claim create failed: ${r.status} ${r.text.slice(0, 200)}`);
  await app.ctx.bus.drain();
  return r.json.id;
}

/** Wall-clock milliseconds taken by a synchronous function. */
export function timed(fn) {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}
