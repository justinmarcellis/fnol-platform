#!/usr/bin/env node
// Generates docs/api-reference.md from architecture/contracts/openapi.yaml (zero dependencies).
//
//   node architecture/contracts/tools/gen-api-reference.mjs            write docs/api-reference.md
//   node architecture/contracts/tools/gen-api-reference.mjs --check    exit 1 if the file is out of date
//   options: --spec <openapi.yaml>  --out <markdown file>  --template <markdown file>
//
// Everything between the BEGIN/END GENERATED markers is rebuilt; every other line (the hand-written
// sections: authentication, tenancy, errors, events and webhooks, pagination) is preserved byte for byte.
// When the output file does not exist it is created from api-reference.template.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseYaml } from './yaml-lite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.resolve(HERE, '..');
export const BEGIN = '<!-- BEGIN GENERATED -->';
export const END = '<!-- END GENERATED -->';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// ---------------------------------------------------------------- reference resolution
function pointer(doc, ptr) {
  let cur = doc;
  for (const seg of ptr.split('/').filter(Boolean)) {
    cur = cur?.[decodeURIComponent(seg).replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cur;
}

function createResolver(spec, specDir) {
  const files = new Map();
  const loadFile = (rel) => {
    const abs = path.resolve(specDir, rel);
    if (!files.has(abs)) files.set(abs, JSON.parse(fs.readFileSync(abs, 'utf8')));
    return { doc: files.get(abs), dir: path.dirname(abs) };
  };
  /** Resolve a $ref relative to `base` ({ doc, dir }). Returns { schema, base, name }. */
  function resolveRef(ref, base) {
    const [file, ptr = ''] = ref.split('#');
    const target = file ? loadFile(path.relative(specDir, path.resolve(base.dir, file))) : base;
    const schema = ptr ? pointer(target.doc, ptr) : target.doc;
    if (schema === undefined) throw new Error(`Unresolvable $ref ${ref}`);
    const segs = ptr.split('/').filter(Boolean);
    const name = segs.length ? segs[segs.length - 1] : path.basename(file).replace(/\.schema\.json$/, '');
    return { schema, base: target, name, local: !file };
  }
  return { resolveRef, root: { doc: spec, dir: specDir }, loadFile };
}

// ---------------------------------------------------------------- markdown helpers
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
const slug = (s) => s.toLowerCase().replace(/[^\w\- ]/g, '').trim().replace(/ /g, '-');
const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;

function describeType(schema, base, R, depth = 0) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (schema.$ref) {
    const r = R.resolveRef(schema.$ref, base);
    if (r.local && /^#\/components\/schemas\//.test(schema.$ref)) return `[${r.name}](#schema-${slug(r.name)})`;
    const resolved = r.schema;
    // short scalars (ids, enums) read better inline than as a bare name
    if (resolved && typeof resolved === 'object' && !resolved.properties && !resolved.allOf && depth < 3 && (resolved.type || resolved.enum)) {
      return describeType(resolved, r.base, R, depth + 1);
    }
    return code(r.name);
  }
  if (schema.allOf) return schema.allOf.map((s) => describeType(s, base, R, depth + 1)).filter((t) => t !== 'any').join(' & ') || 'object';
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).map((s) => describeType(s, base, R, depth + 1)).join(' \\| ');
  if (schema.enum) return `${typeLabel(schema)} (${schema.enum.map((e) => code(e)).join(', ')})`;
  if (schema.const !== undefined) return `${code(JSON.stringify(schema.const))}`;
  if (schema.type === 'array') return `array of ${describeType(schema.items, base, R, depth + 1)}`;
  return typeLabel(schema);
}

function typeLabel(schema) {
  const t = Array.isArray(schema.type) ? schema.type.join(' \\| ') : schema.type ?? 'any';
  return schema.format ? `${t} (${schema.format})` : t;
}

/** Flatten allOf/$ref into { properties, required } with each property carrying its own base for ref resolution. */
function objectShape(schema, base, R, seen = new Set()) {
  const out = { properties: {}, required: new Set(), description: undefined };
  if (!schema || typeof schema !== 'object') return out;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return out;
    seen.add(schema.$ref);
    const r = R.resolveRef(schema.$ref, base);
    const inner = objectShape(r.schema, r.base, R, seen);
    // sibling keywords next to a $ref (for example a description) override the target
    return { ...inner, description: schema.description ?? inner.description };
  }
  for (const part of schema.allOf ?? []) {
    const s = objectShape(part, base, R, seen);
    Object.assign(out.properties, s.properties);
    s.required.forEach((r) => out.required.add(r));
    out.description ??= s.description;
  }
  for (const [k, v] of Object.entries(schema.properties ?? {})) out.properties[k] = { schema: v, base };
  (schema.required ?? []).forEach((r) => out.required.add(r));
  out.description = schema.description ?? out.description;
  return out;
}

function propertyNotes(schema, base, R) {
  const parts = [];
  let s = schema;
  let b = base;
  if (s?.$ref) { const r = R.resolveRef(s.$ref, b); parts.push(s.description ?? r.schema.description ?? ''); s = { ...r.schema, ...s }; b = r.base; } else parts.push(s?.description ?? '');
  if (s?.default !== undefined) parts.push(`Default ${code(JSON.stringify(s.default))}.`);
  if (s?.minimum !== undefined || s?.maximum !== undefined) parts.push(`Range ${s.minimum ?? ''}..${s.maximum ?? ''}.`);
  if (s?.examples?.length) parts.push(`Example: ${code(JSON.stringify(s.examples[0]))}.`);
  if (s?.['x-pii']) parts.push('PII, redacted for roles without access.');
  return parts.filter(Boolean).join(' ');
}

function fieldTable(schema, base, R) {
  const shape = objectShape(schema, base, R);
  const names = Object.keys(shape.properties);
  if (!names.length) return '';
  const rows = names.map((n) => {
    const p = shape.properties[n];
    return `| ${code(n)} | ${describeType(p.schema, p.base, R)} | ${shape.required.has(n) ? 'yes' : ''} | ${esc(propertyNotes(p.schema, p.base, R))} |`;
  });
  return ['| Field | Type | Required | Description |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

// ---------------------------------------------------------------- operations
function bodySchemas(content, base, R) {
  const json = content?.['application/json'];
  return json?.schema ? { schema: json.schema, base } : null;
}

function renderParameters(params, base, R) {
  const rows = [];
  for (const p of params) {
    let param = p;
    let b = base;
    if (p.$ref) { const r = R.resolveRef(p.$ref, base); param = r.schema; b = r.base; }
    rows.push(`| ${code(param.name)} | ${param.in} | ${describeType(param.schema, b, R)} | ${param.required || param.in === 'path' ? 'yes' : ''} | ${esc(propertyNotes(param.schema ?? {}, b, R) || param.description || '')}${param.description && propertyNotes(param.schema ?? {}, b, R) ? ` ${esc(param.description)}` : ''} |`);
  }
  if (!rows.length) return '';
  return ['**Parameters**', '', '| Name | In | Type | Required | Description |', '| --- | --- | --- | --- | --- |', ...rows, ''].join('\n');
}

function renderOperation(method, p, op, pathItem, R) {
  const base = R.root;
  const title = `${method.toUpperCase()} ${p}`;
  const out = [`#### ${title}`, ''];
  if (op.summary) out.push(`${op.summary}`, '');
  if (op.description) out.push(op.description.trim(), '');
  const roles = op.security && op.security.length === 0 ? 'public, no token needed' : (op['x-roles']?.length ? op['x-roles'].map(code).join(', ') : 'any authenticated user');
  const meta = [`Operation ${code(op.operationId)}`, `Roles: ${roles}`];
  if (op['x-module']) meta.push(`Module: ${code(op['x-module'])}`);
  out.push(meta.join(' · '), '');
  const params = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])];
  const ptable = renderParameters(params, base, R);
  if (ptable) out.push(ptable);
  if (op.requestBody) {
    const b = bodySchemas(op.requestBody.content, base, R);
    out.push(`**Request body**${op.requestBody.required ? ' (required)' : ''}`, '');
    if (b) {
      const table = fieldTable(b.schema, b.base, R);
      out.push(table || `Type: ${describeType(b.schema, b.base, R)}`, '');
    }
  }
  out.push('**Responses**', '', '| Status | Description | Body |', '| --- | --- | --- |');
  for (const [status, resp0] of Object.entries(op.responses ?? {})) {
    let resp = resp0;
    let b = base;
    if (resp0.$ref) { const r = R.resolveRef(resp0.$ref, base); resp = r.schema; b = r.base; }
    const body = bodySchemas(resp.content, b, R);
    out.push(`| ${status} | ${esc(resp.description)} | ${body ? esc(describeType(body.schema, body.base, R)) : ''} |`);
  }
  out.push('');
  return out.join('\n');
}

function renderEndpoints(spec, R) {
  const byTag = new Map((spec.tags ?? []).map((t) => [t.name, []]));
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    for (const m of METHODS) {
      if (!item[m]) continue;
      const tag = item[m].tags?.[0] ?? 'other';
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({ method: m, path: p, op: item[m], item });
    }
  }
  const out = ['## Endpoint reference', '', `All paths are relative to the base path ${code('/api/v1')}.`, ''];
  const index = ['| Method | Path | Operation | Summary |', '| --- | --- | --- | --- |'];
  const sections = [];
  for (const [tag, ops] of byTag) {
    if (!ops.length) continue;
    sections.push(`### ${tag}`, '');
    for (const o of ops) {
      const title = `${o.method.toUpperCase()} ${o.path}`;
      index.push(`| ${o.method.toUpperCase()} | [${code(o.path)}](#${slug(title)}) | ${code(o.op.operationId)} | ${esc(o.op.summary ?? '')} |`);
      sections.push(renderOperation(o.method, o.path, o.op, o.item, R));
    }
  }
  return [...out, ...index, '', ...sections].join('\n');
}

function renderSchemas(spec, R) {
  const out = ['## Schemas', '', 'Shared request and response shapes from the OpenAPI components. Domain objects are listed in the next section.', ''];
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    out.push(`### Schema: ${name}`, '');
    if (schema.description) out.push(schema.description.trim(), '');
    const table = fieldTable(schema, R.root, R);
    out.push(table || `Type: ${describeType(schema, R.root, R)}`, '');
  }
  return out.join('\n');
}

function readJsonDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.schema.json')).sort().map((f) => ({ file: f, doc: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

function renderDomain(specDir) {
  const items = readJsonDir(path.join(specDir, 'domain')).filter((x) => x.file !== 'common.schema.json');
  if (!items.length) return '';
  const rows = items.map(({ file, doc }) => `| ${code(doc.title ?? file.replace(/\.schema\.json$/, ''))} | ${code(`domain/${file}`)} | ${esc(doc.description ?? '')} |`);
  return ['## Domain objects', '', 'Each object is defined by a JSON Schema (2020-12) under `architecture/contracts/domain/`; the API and storage share it.', '',
    '| Object | Schema file | Description |', '| --- | --- | --- |', ...rows, ''].join('\n');
}

function renderEvents(specDir, R) {
  const dir = path.join(specDir, 'events');
  const all = readJsonDir(dir);
  const envelope = all.find((x) => x.file === 'envelope.schema.json');
  const events = all.filter((x) => x.file !== 'envelope.schema.json');
  if (!envelope && !events.length) return '';
  const out = ['## Event catalog', ''];
  if (envelope) {
    const base = { doc: envelope.doc, dir };
    out.push('### Event envelope', '', esc(envelope.doc.description ?? ''), '', fieldTable(envelope.doc, base, R), '');
  }
  for (const { file, doc } of events) {
    const base = { doc, dir };
    const type = doc.properties?.type?.const ?? doc.title;
    out.push(`### ${type}`, '');
    if (doc.description) out.push(doc.description.trim(), '');
    const data = doc.properties?.data;
    const table = data ? fieldTable(data, base, R) : '';
    out.push(table ? `Payload ${code('data')}:` : `Payload ${code('data')} has no fixed fields.`, '');
    if (table) out.push(table, '');
    out.push(`Schema: ${code(`events/${file}`)}${doc['x-publisher'] ? ` · Published by ${code(doc['x-publisher'])}` : ''}`, '');
  }
  return out.join('\n');
}

/**
 * Build the generated markdown (without markers) from an OpenAPI document.
 * @param {object} spec parsed openapi.yaml
 * @param {string} specDir directory of the spec, for resolving relative $refs
 * @returns {string}
 */
export function buildGenerated(spec, specDir) {
  const R = createResolver(spec, specDir);
  const servers = (spec.servers ?? []).map((s) => `- ${code(s.url)}${s.description ? `: ${s.description}` : ''}`);
  const head = ['## Overview of the API', '', spec.info?.description ? spec.info.description.trim() : '', ''];
  if (servers.length) head.push('**Servers**', '', ...servers, '');
  return [
    head.join('\n'), renderEndpoints(spec, R), renderSchemas(spec, R), renderDomain(specDir), renderEvents(specDir, R),
  ].filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * Replace the generated block of `existing` with `generated`, keeping all other text untouched.
 * @param {string} existing current file contents
 * @param {string} generated new generated markdown (no markers)
 * @returns {string}
 */
export function mergeDocument(existing, generated) {
  const b = existing.indexOf(BEGIN);
  const e = existing.indexOf(END);
  if (b < 0 || e < 0 || e < b || existing.indexOf(BEGIN, b + 1) >= 0 || existing.indexOf(END, e + 1) >= 0) {
    throw new Error(`Expected exactly one "${BEGIN}" ... "${END}" block in the output file`);
  }
  return `${existing.slice(0, b)}${BEGIN}\n\n${generated}\n\n${existing.slice(e)}`;
}

/** Hand-written template plus an empty generated block. */
export function newDocument(template, generated) {
  const body = template.trimEnd();
  return `${body}\n\n${BEGIN}\n\n${generated}\n\n${END}\n`;
}

/**
 * Run the generator.
 * @param {{ spec?: string, out?: string, template?: string, check?: boolean }} [o]
 * @returns {{ changed: boolean, created: boolean, out: string, content: string }}
 */
export function run({ spec, out, template, check = false } = {}) {
  const specPath = path.resolve(spec ?? path.join(CONTRACTS, 'openapi.yaml'));
  const outPath = path.resolve(out ?? path.join(CONTRACTS, '..', '..', 'docs', 'api-reference.md'));
  const templatePath = path.resolve(template ?? path.join(HERE, 'api-reference.template.md'));
  const doc = parseYaml(fs.readFileSync(specPath, 'utf8'));
  const generated = buildGenerated(doc, path.dirname(specPath));
  const exists = fs.existsSync(outPath);
  const content = exists
    ? mergeDocument(fs.readFileSync(outPath, 'utf8'), generated)
    : newDocument(fs.readFileSync(templatePath, 'utf8'), generated);
  const changed = !exists || content !== fs.readFileSync(outPath, 'utf8');
  if (!check && changed) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content);
  }
  return { changed, created: !exists, out: outPath, content };
}

function main(argv) {
  const args = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--spec' || a === '--out' || a === '--template') args[a.slice(2)] = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: gen-api-reference.mjs [--check] [--spec openapi.yaml] [--out docs/api-reference.md] [--template file.md]');
      return 0;
    } else { console.error(`Unknown argument: ${a}`); return 2; }
  }
  try {
    const r = run(args);
    const rel = path.relative(process.cwd(), r.out) || r.out;
    if (args.check) {
      if (r.changed) { console.error(`${rel} is out of date. Run: node architecture/contracts/tools/gen-api-reference.mjs`); return 1; }
      console.log(`${rel} is up to date`);
      return 0;
    }
    console.log(r.changed ? `${r.created ? 'Created' : 'Updated'} ${rel}` : `${rel} already up to date`);
    return 0;
  } catch (e) {
    console.error(`gen-api-reference: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
