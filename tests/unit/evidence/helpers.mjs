import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createApp } from '../../../src/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = pathToFileURL(path.resolve(here, '../../../src/modules/evidence/index.mjs')).href;

/** Fake ctx.ai: records calls; behavior by task. */
export function makeFakeAi(overrides = {}) {
  const calls = [];
  const env = (output, confidence = 0.9) => ({ output, provider: 'local', model: 'fake-v1', confidence, explanation: 'fake extraction', usage: {} });
  return {
    calls,
    async run(task, input, opts) {
      calls.push({ task, input, opts });
      if (overrides[task]) return overrides[task](input);
      if (task === 'extract_document') {
        const t = input.text.toLowerCase();
        const kind = input.kind ?? (t.includes('police') ? 'police_report' : t.includes('estimate') ? 'estimate' : 'other');
        const fields = [];
        const num = /report (?:no|number)[:.]?\s*([A-Z0-9-]+)/i.exec(input.text);
        if (num) fields.push({ name: 'policeReportNumber', value: num[1], confidence: 0.95, provenance: { snippet: num[0] } });
        if (/cited: *(.+)/i.test(input.text)) fields.push({ name: 'citedParty', value: /cited: *(.+)/i.exec(input.text)[1].trim(), confidence: 0.55, provenance: { snippet: 'Cited line' } });
        const tot = /total[:.]?\s*\$?([\d,.]+)/i.exec(input.text);
        if (tot) fields.push({ name: 'estimateTotal', value: Number(tot[1].replace(/,/g, '')), confidence: 0.85, provenance: { snippet: tot[0] } });
        return env({ kind, fields, needsReview: fields.some((f) => f.confidence < 0.6) });
      }
      if (task === 'classify_photo') {
        const md = input.metadata;
        return env({
          kind: 'photo', damageAreas: md?.damageAreas ?? ['front_bumper'], vehicle: { make: md?.make ?? 'Examplar', model: md?.model ?? 'Sedan', color: md?.color ?? 'blue' },
          fields: [{ name: 'damageAreas', value: md?.damageAreas ?? ['front_bumper'], confidence: md ? 0.9 : 0.9, provenance: { snippet: 'image' } }], needsReview: false,
        }, 0.9);
      }
      throw new Error(`unexpected task ${task}`);
    },
  };
}

export async function bootEvidenceApp({ ai = makeFakeAi() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-ev-'));
  const modulesDir = path.join(dir, 'modules');
  fs.mkdirSync(path.join(modulesDir, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(modulesDir, 'evidence', 'index.mjs'), `export { default } from '${entry}';\n`);
  const tenantsDir = path.join(dir, 'tenants');
  fs.mkdirSync(tenantsDir);
  for (const id of ['alpha', 'beta']) fs.writeFileSync(path.join(tenantsDir, `${id}.json`), JSON.stringify({ id, displayName: `${id} Example` }));
  const dbPath = path.join(dir, 'data', 'fnol.db');
  const app = await createApp({ dbPath, port: 0, secretsDir: path.join(dir, 'secrets'), tenantsDir, modulesDir, logLevel: 'silent' });
  app.ctx.ai = ai;
  app.dir = dir;
  app.ai = ai;
  const close = app.close;
  app.close = async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); };
  app.token = (roles, tenantId = 'alpha', sub = 'u1') => app.ctx.auth.issueToken({ sub, tenantId, roles });
  app.ev = (tenantId = 'alpha') => app.ctx.forTenant(tenantId).modules.evidence;
  return app;
}

export async function call(app, method, url, { token, body, raw, headers } = {}) {
  const res = await fetch(app.url + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, json, buf, headers: res.headers };
}

export const textBytes = (s) => Buffer.from(s, 'utf8');

/** Minimal PDF with uncompressed text objects. */
export function simplePdf(lines) {
  const ops = lines.map((l, i) => `BT /F1 12 Tf 72 ${700 - i * 20} Td (${l.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n');
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${ops.length} >>\nstream\n${ops}\nendstream\nendobj\n%%EOF\n`, 'latin1');
}

export function multipart(parts) {
  const b = '----testboundary7f3a';
  const chunks = [];
  for (const p of parts) {
    const head = `--${b}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ''}\r\n`;
    chunks.push(Buffer.from(head), Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${b}--\r\n`));
  return { raw: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
