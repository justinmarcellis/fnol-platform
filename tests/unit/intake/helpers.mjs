import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createApp } from '../../../src/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const href = (p) => pathToFileURL(p).href;

const t = (en, es) => ({ en, es });

/** Inline synthetic sample tenant (fictional carrier). */
export function sampleTenant(id = 'tn-one') {
  return {
    tenantId: id, version: 1, displayName: 'Sample Mutual (fictional)', timeZone: 'America/Chicago', locales: ['en', 'es'],
    branding: { primaryColor: '#224466', fraudWarning: { WI: t('Illustrative notice: false information may be a crime.', 'Aviso ilustrativo: la informacion falsa puede ser un delito.') } },
    lobs: [{ id: 'personal_auto', enabled: true, label: t('Personal auto', 'Auto personal'), channels: ['claimant_web', 'csr_phone', 'agent_portal'],
      lossTypes: [{ id: 'collision', label: t('Collision', 'Colision'), causes: ['collision'] }, { id: 'glass', label: t('Glass', 'Cristales'), causes: ['glass'] }] }],
    questionSets: [{
      id: 'auto-general', lob: 'personal_auto', version: 1,
      questions: [
        { id: 'loss_date', text: t('When did the loss happen?', 'Cuando ocurrio la perdida?'), type: 'date', required: true, validation: { notInFuture: true }, mapsTo: 'loss.lossDate', aiAssist: true, order: 10 },
        { id: 'loss_description', text: t('Tell us what happened.', 'Cuentenos que sucedio.'), type: 'longtext', required: true, aiAssist: true, mapsTo: 'loss.description', order: 20 },
        { id: 'injuries', text: t('Was anyone hurt?', 'Hubo personas lesionadas?'), type: 'boolean', required: true, mapsTo: 'loss.injuriesReported', aiAssist: true, order: 30 },
        { id: 'vehicle_drivable', text: t('Can the vehicle be driven?', 'Se puede conducir el vehiculo?'), type: 'boolean', required: true, mapsTo: 'vehicles[role=insured].drivable', order: 40 },
        { id: 'other_party_involved', text: t('Was another vehicle or person involved?', 'Hubo otro vehiculo o persona involucrada?'), type: 'boolean', required: true, order: 50 },
        { id: 'other_party_info', text: t('Other party details', 'Datos de la otra parte'), type: 'party', pii: true, order: 60,
          showIf: { fact: 'answers.other_party_involved', op: 'eq', value: true }, requiredIf: { fact: 'answers.other_party_involved', op: 'eq', value: true } },
        { id: 'driver_phone', text: t('Driver phone', 'Telefono del conductor'), type: 'phone', pii: true, mapsTo: 'parties[role=driver].phone', order: 65 },
        { id: 'severity_band', text: t('How bad is the damage?', 'Que tan grave es el dano?'), type: 'select', order: 70,
          options: [{ value: 'minor', label: t('Minor', 'Menor') }, { value: 'major', label: t('Major', 'Mayor') }] },
        { id: 'fraud_disclosure', text: t('I understand false information is a crime.', 'Entiendo que la informacion falsa es un delito.'), type: 'disclosure', required: true, order: 99 },
      ],
    }],
    rules: [{ id: 'IN-INJURY-PHONE', name: 'Injury needs driver phone', stage: 'intake', priority: 10,
      when: { fact: 'answers.injuries', op: 'eq', value: true }, then: [{ type: 'require_question', questionId: 'driver_phone' }] }],
    queues: [{ id: 'general', label: t('General', 'General') }],
    timers: [],
    ai: { provider: 'local' },
    security: { sessionTtlMinutes: 60 },
  };
}

/** Boot an isolated app: real intake + config modules, fake rules + claims. */
export async function bootIntakeApp({ tenants = [sampleTenant('tn-one'), sampleTenant('tn-two')] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-intake-'));
  const modulesDir = path.join(dir, 'modules');
  const wrap = (name, file, fake) => {
    fs.mkdirSync(path.join(modulesDir, name), { recursive: true });
    const src = fake
      ? `import { fakes } from '${href(file)}';\nexport default fakes.${fake};\n`
      : `export { default } from '${href(file)}';\n`;
    fs.writeFileSync(path.join(modulesDir, name, 'index.mjs'), src);
  };
  wrap('intake', path.join(root, 'src/modules/intake/index.mjs'));
  wrap('config', path.join(root, 'src/modules/config/index.mjs'));
  wrap('rules', path.join(here, 'fakes.mjs'), 'rules');
  wrap('claims', path.join(here, 'fakes.mjs'), 'claims');
  wrap('coverage', path.join(here, 'fakes.mjs'), 'coverage');
  const tenantsDir = path.join(dir, 'tenants');
  fs.mkdirSync(tenantsDir);
  for (const cfg of tenants) fs.writeFileSync(path.join(tenantsDir, `${cfg.tenantId}.json`), JSON.stringify(cfg));
  const app = await createApp({ dbPath: ':memory:', port: 0, secretsDir: path.join(dir, 'secrets'), tenantsDir, modulesDir, logLevel: 'silent' });
  const close = app.close;
  app.close = async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); };
  app.token = (roles, tenantId = 'tn-one', sub = 'u1') => app.ctx.auth.issueToken({ sub, tenantId, roles });
  app.intake = (tenantId = 'tn-one') => app.ctx.forTenant(tenantId).modules.intake;
  return app;
}

export async function call(app, method, url, { token, body, headers } = {}) {
  const res = await fetch(app.url + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

export { href, root };
