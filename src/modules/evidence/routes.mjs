// HTTP routes for evidence, matching openapi.yaml (evidence tag) including x-roles.
import { parseMultipart, KINDS } from './parse.mjs';

const BASE = '/api/v1/claims/:claimId/documents';
const READ = ['claimant', 'csr', 'adjuster', 'supervisor', 'auditor', 'integration'];
const SOURCE = { claimant: 'claimant_upload', csr: 'csr_upload' };

const actorOf = (req) => ({ type: req.user.roles?.includes('integration') ? 'integration' : 'user', id: req.user.sub, role: req.user.roles?.[0] });
const isClaimantOnly = (req) => req.user.roles?.includes('claimant') && req.user.roles.length === 1;

const PII_ROLES = ['csr', 'adjuster', 'supervisor', 'carrier_admin', 'platform_admin'];
const canSeePii = (req) => req.user.roles?.some((r) => PII_ROLES.includes(r));
const MASK = '[redacted]';

/** SEC2-017: mask pii:true extraction fields (value, normalizedValue, provenance span) for roles without PII access. */
function maskExtraction(ext) {
  if (!ext || !Array.isArray(ext.fields)) return ext;
  return {
    ...ext,
    fields: ext.fields.map((f) => {
      if (!f.pii) return f;
      const { span: _s, ...prov } = f.provenance ?? {};
      return { ...f, value: MASK, ...(f.normalizedValue !== undefined ? { normalizedValue: MASK } : {}), provenance: prov };
    }),
  };
}

/** Claimants never see storage keys or extracted fields; roles without PII access get pii fields masked. */
function shape(req, d) {
  if (!isClaimantOnly(req)) return canSeePii(req) || !d.extraction ? d : { ...d, extraction: maskExtraction(d.extraction) };
  const { storageKey: _s, extraction, ...rest } = d;
  return extraction ? { ...rest, extraction: { id: extraction.id, status: extraction.status } } : rest;
}

function parseJsonField(v, name, AppError) {
  if (v === undefined || v === '') return undefined;
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { throw new AppError('validation_error', `${name} must be valid JSON`, 400); }
}

/** Max base64 length for the largest allowed upload (10 MB -> ~13.4 MB) plus whitespace slack. */
const MAX_B64_CHARS = 16 * 1024 * 1024;

/** SEC2-006: length check, then a single linear charCode pass (no regex). Whitespace is ignored. */
function decodeBase64(s, AppError) {
  const bad = () => new AppError('validation_error', 'contentBase64 is not valid base64', 400);
  if (s.length > MAX_B64_CHARS) throw new AppError('payload_too_large', 'contentBase64 is too large', 413);
  let data = 0;
  let pad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 10 || c === 13 || c === 9) continue;
    if (c === 61) { pad++; if (pad > 2) throw bad(); continue; }
    if (pad > 0) throw bad(); // data after '='
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47) data++;
    else throw bad();
  }
  if (data === 0) throw bad();
  return Buffer.from(s, 'base64');
}

/** Normalize either upload encoding into addDocument input. */
function readUpload(req) {
  const { AppError } = req.ctx;
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (type.startsWith('multipart/form-data')) {
    const parts = parseMultipart(req.rawBody ?? Buffer.alloc(0), req.headers['content-type']);
    if (!parts) throw new AppError('validation_error', 'Missing multipart boundary', 400);
    const file = parts.find((p) => p.name === 'file');
    if (!file) throw new AppError('validation_error', 'Missing file part', 400);
    const text = (n) => parts.find((p) => p.name === n && p.filename === undefined)?.data.toString('utf8');
    return {
      kind: text('kind') || undefined, filename: file.filename || 'upload', contentType: file.contentType,
      bytes: file.data, metadata: parseJsonField(text('metadata'), 'metadata', AppError), description: text('description'),
    };
  }
  const b = req.body;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    if (typeof b.contentBase64 !== 'string' || !b.contentBase64) throw new AppError('validation_error', 'contentBase64 is required', 400);
    const bytes = decodeBase64(b.contentBase64, AppError);
    return {
      kind: b.kind, filename: b.filename, contentType: b.contentType, bytes,
      metadata: b.metadata, description: b.description,
    };
  }
  throw new AppError('unsupported_media_type', 'Use multipart/form-data or application/json', 415);
}

export function registerRoutes(router) {
  router.post(BASE, async (req, res) => {
    const input = readUpload(req);
    const role = req.user.roles?.find((r) => SOURCE[r]);
    const doc = await req.ctx.modules.evidence.addDocument(req.params.claimId, { ...input, source: SOURCE[role] ?? 'api' }, { actor: actorOf(req) });
    res.json(201, shape(req, doc));
  }, { roles: ['claimant', 'csr', 'adjuster', 'integration'] });

  router.get(BASE, async (req, res) => {
    const kind = typeof req.query.kind === 'string' && KINDS.includes(req.query.kind) ? req.query.kind : undefined;
    const items = await req.ctx.modules.evidence.listDocuments(req.params.claimId, { kind });
    res.json(200, { items: items.map((d) => shape(req, d)) });
  }, { roles: READ });

  router.get(`${BASE}/:documentId`, async (req, res) => {
    res.json(200, shape(req, await req.ctx.modules.evidence.getDocument(req.params.claimId, req.params.documentId)));
  }, { roles: READ });

  router.get(`${BASE}/:documentId/content`, async (req, res) => {
    const { contentType, bytes } = await req.ctx.modules.evidence.readContent(req.params.claimId, req.params.documentId, { actor: actorOf(req) });
    res.writeHead(200, { 'content-type': contentType, 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(bytes);
  }, { roles: ['csr', 'adjuster', 'supervisor'] });

  router.get(`${BASE}/:documentId/extraction`, async (req, res) => {
    const d = await req.ctx.modules.evidence.getDocument(req.params.claimId, req.params.documentId);
    res.json(200, canSeePii(req) ? d.extraction : maskExtraction(d.extraction));
  }, { roles: ['csr', 'adjuster', 'supervisor', 'auditor', 'integration'] });

  router.post(`${BASE}/:documentId/extraction`, async (req, res) => {
    const ev = req.ctx.modules.evidence;
    await ev.getDocument(req.params.claimId, req.params.documentId); // 404 check
    // Queue: respond immediately, run in the background.
    setImmediate(() => ev.extract(req.params.documentId, { force: true }).catch(() => {}));
    res.json(202, { status: 'queued' });
  }, { roles: ['adjuster', 'supervisor'] });

  router.post(`${BASE}/:documentId/extraction/review`, async (req, res) => {
    const ev = req.ctx.modules.evidence;
    await ev.getDocument(req.params.claimId, req.params.documentId);
    const fields = req.body?.fields;
    if (!Array.isArray(fields)) throw new req.ctx.AppError('validation_error', 'fields array is required', 400);
    res.json(200, await ev.reviewExtraction(req.params.documentId, fields, { actor: actorOf(req) }));
  }, { roles: ['csr', 'adjuster', 'supervisor'] });
}
