import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('Dockerfile: slim node 22, non-root, healthcheck, starts server', () => {
  const d = read('Dockerfile');
  assert.match(d, /^FROM node:22-slim\b/m);
  assert.match(d, /^USER node$/m);
  assert.match(d, /^HEALTHCHECK\b/m);
  assert.match(d, /\/healthz/);
  assert.match(d, /^CMD \[.*src\/server\.mjs/m);
  assert.match(d, /0\.0\.0\.0/);
  assert.doesNotMatch(d, /^ENV .*(KEY|SECRET|PASSWORD|TOKEN)=/mi);
});

test('.dockerignore excludes git, node_modules, terraform, infra, env files', () => {
  const lines = read('.dockerignore').split('\n').map((l) => l.trim());
  for (const e of ['.git', 'node_modules', '.terraform', 'infra', '.env', '.env.*', '.secrets']) {
    assert.ok(lines.includes(e), `missing ${e}`);
  }
});

test('service.yaml: Cloud Run dev service with internal ingress and runtime SA', () => {
  const y = read('infra/cloudrun/service.yaml');
  assert.match(y, /^apiVersion: serving\.knative\.dev\/v1$/m);
  assert.match(y, /^kind: Service$/m);
  assert.match(y, /run\.googleapis\.com\/ingress: internal-and-cloud-load-balancing/);
  assert.match(y, /serviceAccountName: fnol-intake-api@jmfnol-app-dev\.iam\.gserviceaccount\.com/);
  assert.match(y, /startupProbe:/);
  assert.match(y, /livenessProbe:/);
  assert.match(y, /path: \/healthz/);
  assert.match(read('infra/2-env/identities.tf'), /"intake-api"/);
});

test('service.yaml: secrets only by Secret Manager reference', () => {
  const y = read('infra/cloudrun/service.yaml');
  const lines = y.split('\n');
  lines.forEach((l, i) => {
    const m = l.match(/- name: ([A-Z0-9_]*(KEY|SECRET|PASSWORD|TOKEN|PSK)[A-Z0-9_]*)$/);
    if (m) {
      const block = lines.slice(i + 1, i + 6).join('\n');
      assert.match(block, /secretKeyRef:/, `${m[1]} must use secretKeyRef`);
      assert.doesNotMatch(block, /^\s+value:/m, `${m[1]} must not have a literal value`);
    }
  });
  assert.match(y, /secretName: projects\/jmfnol-sec-dev\/secrets\//);
  assert.doesNotMatch(y, /-----BEGIN|AIza|ghp_/);
});

test('deployment guide covers stages, production changes and not-run marking', () => {
  const g = read('docs/deployment.md');
  for (const s of ['0-bootstrap', '1-org', '2-env', 'Cloud SQL', 'Firestore', 'Cloud KMS', 'Pub/Sub', 'gcloud run services replace']) {
    assert.ok(g.includes(s), `missing ${s}`);
  }
  assert.match(g, /NOT RUN/);
});
