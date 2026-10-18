// Evidence service (modules.md#evidence). ctx is tenant-bound. Never logs bytes or extracted PII.
import crypto from 'node:crypto';
import { KINDS, MAX_BYTES, ALLOWED_TYPES, baseType, readableText, detectKind } from './parse.mjs';
import { blobKey, putBlob, getBlob } from './blobs.mjs';

const TEXT_CAP = 20000;
const PII_FIELDS = new Set(['citedParty', 'atFaultParty']);
const HIGH_CONFIDENCE = 0.8;
const LOW_CONFIDENCE = 0.6;
const NO_SIDECAR_CAP = 0.4;

const actorId = (a) => (typeof a === 'string' ? a : a?.id ?? 'system');
const actorObj = (a) => (typeof a === 'string' ? { type: 'user', id: a } : a?.type ? a : { type: 'system' });
const clamp = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** @param {object} ctx tenant-bound context */
export function createService(ctx) {
  const AppError = ctx.AppError;
  const tid = () => ctx.tenant.id;

  function rowToDoc(row) {
    const d = ctx.db.parseJson(row.doc, {});
    return {
      id: row.id, tenantId: tid(), claimId: row.claim_id, kind: row.kind, filename: d.filename,
      contentType: row.content_type, sizeBytes: row.size_bytes, sha256: row.sha256, storageKey: row.storage_key,
      uploadedBy: d.uploadedBy, uploadedAt: row.uploaded_at, source: d.source, captureMetadata: d.captureMetadata,
    };
  }

  function loadExtraction(documentId) {
    const row = ctx.db.get('SELECT * FROM extractions WHERE document_id = ?', documentId);
    if (!row) return null;
    const body = JSON.parse(ctx.crypto.decryptPii(row.doc));
    return { id: row.id, status: row.status, ...body };
  }

  function saveExtraction(id, ext) {
    const { id: _i, status, ...body } = ext;
    ctx.db.update('extractions', id, {
      status,
      doc: ctx.crypto.encryptPii(JSON.stringify(body)),
      ai_provider: ext.ai?.provider ?? null,
      ai_model: ext.ai?.model ?? null,
      confidence: ext.ai?.confidence ?? null,
      completed_at: ext.completedAt ?? null,
    });
  }

  function docRow(documentId, claimId) {
    const row = ctx.db.get('SELECT * FROM documents WHERE id = ?', documentId);
    if (!row || (claimId && row.claim_id !== claimId)) throw new AppError('not_found', 'Document not found', 404);
    return row;
  }

  async function assertClaim(claimId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(claimId))) throw new AppError('not_found', 'Claim not found', 404);
    if ('claims' in ctx.modules) await ctx.modules.claims.getClaim(claimId); // throws not_found
  }

  const svc = {
    /** Store (encrypted) and register a document. Extraction is pending; claim.evidence.added is published. */
    async addDocument(claimId, { kind, filename, contentType, bytes, source, metadata, description } = {}, { actor } = {}) {
      await assertClaim(claimId);
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new AppError('validation_error', 'File content is empty', 400);
      if (bytes.length > MAX_BYTES) throw new AppError('payload_too_large', `File exceeds ${MAX_BYTES} bytes`, 413);
      const ct = baseType(contentType);
      if (!ALLOWED_TYPES.includes(ct)) throw new AppError('unsupported_media_type', `Content type not allowed: ${ct || 'none'}`, 415);
      if (kind && !KINDS.includes(kind)) throw new AppError('validation_error', `kind must be one of ${KINDS.join(', ')}`, 400);
      if (metadata !== undefined && (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))) {
        throw new AppError('validation_error', 'metadata must be an object', 400);
      }
      const name = String(filename ?? 'upload').replace(/[\r\n"]/g, '').slice(0, 200) || 'upload';
      const finalKind = kind ?? detectKind({ filename: name, contentType: ct, text: readableText(bytes, ct) });
      const id = ctx.db.id('doc');
      const key = blobKey(tid(), claimId, id);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const now = ctx.clock.nowIso();
      const extId = ctx.db.id('ext');
      const cap = metadata && (metadata.takenAt || metadata.geo || metadata.device)
        ? Object.fromEntries(['takenAt', 'geo', 'device'].filter((k) => metadata[k] !== undefined).map((k) => [k, metadata[k]]))
        : undefined;
      const doc = {
        filename: name, uploadedBy: actorObj(actor), source: source ?? 'api', captureMetadata: cap,
        sidecar: metadata ?? null, description: description ? String(description).slice(0, 500) : undefined, autoKind: !kind,
      };
      putBlob(ctx, key, bytes);
      ctx.db.transaction(() => {
        ctx.db.insert('documents', {
          id, claim_id: claimId, kind: finalKind, content_type: ct, size_bytes: bytes.length, sha256,
          storage_key: key, doc, uploaded_at: now,
        });
        ctx.db.insert('extractions', {
          id: extId, document_id: id, status: 'pending', doc: ctx.crypto.encryptPii(JSON.stringify({ fields: [] })),
          ai_provider: null, ai_model: null, confidence: null, completed_at: null,
        });
        ctx.audit.record({
          actor: actorId(actor), action: 'evidence.added', entityType: 'document', entityId: id,
          details: { claimId, kind: finalKind, contentType: ct, sizeBytes: bytes.length },
        });
        ctx.bus.publish('claim.evidence.added', claimId, {
          claimId, documentId: id, kind: finalKind, contentType: ct, sizeBytes: bytes.length, sha256, ...(source ? { source } : {}),
        });
      });
      return svc.getDocument(claimId, id);
    },

    /** @returns {Promise<object[]>} documents (with extraction) for the claim */
    async listDocuments(claimId, { kind } = {}) {
      const rows = kind
        ? ctx.db.all('SELECT * FROM documents WHERE claim_id = ? AND kind = ? ORDER BY uploaded_at, id', claimId, kind)
        : ctx.db.all('SELECT * FROM documents WHERE claim_id = ? ORDER BY uploaded_at, id', claimId);
      return rows.map((r) => ({ ...rowToDoc(r), extraction: loadExtraction(r.id) ?? undefined }));
    },

    /** @returns {Promise<object>} Document */
    async getDocument(claimId, documentId) {
      const row = docRow(documentId, claimId);
      return { ...rowToDoc(row), extraction: loadExtraction(row.id) ?? undefined };
    },

    /** Decrypt original bytes. Audited as a sensitive read. */
    async readContent(claimId, documentId, { actor } = {}) {
      const row = docRow(documentId, claimId);
      const bytes = getBlob(ctx, row.storage_key);
      ctx.audit.record({
        actor: actorId(actor), action: 'evidence.content.read', entityType: 'document', entityId: row.id,
        details: { claimId, sensitive: true, sizeBytes: row.size_bytes },
      });
      return { contentType: row.content_type, bytes };
    },

    /** Run AI extraction. Idempotent unless force. Publishes claim.evidence.extracted. */
    async extract(documentId, { force = false } = {}) {
      const row = docRow(documentId);
      const cur = loadExtraction(documentId);
      if (cur && cur.status !== 'pending' && !force) return cur;
      if (cur?.status === 'running' && !force) return cur;
      const docMeta = ctx.db.parseJson(row.doc, {});
      const extId = cur.id;
      const startedAt = ctx.clock.nowIso();
      saveExtraction(extId, { id: extId, status: 'running', fields: [], startedAt });

      const finish = (ext) => {
        const out = { id: extId, startedAt, completedAt: ctx.clock.nowIso(), ...ext };
        ctx.db.transaction(() => {
          saveExtraction(extId, out);
          ctx.audit.record({
            actor: 'system', action: 'evidence.extracted', entityType: 'document', entityId: documentId,
            details: { claimId: row.claim_id, status: out.status, fieldCount: out.fields.length },
          });
          ctx.bus.publish('claim.evidence.extracted', row.claim_id, {
            claimId: row.claim_id, documentId, extractionId: extId, kind: row.kind, status: out.status,
            fieldCount: out.fields.length,
            lowConfidenceFields: out.fields.filter((f) => f.confidence < LOW_CONFIDENCE).map((f) => f.name),
            ...(out.ai ? { ai: out.ai } : {}),
          });
        });
        return { ...out };
      };

      try {
        const bytes = getBlob(ctx, row.storage_key);
        const ct = row.content_type;
        const isImage = ct.startsWith('image/');
        let result;
        if (row.kind === 'photo' && isImage) {
          const sidecar = docMeta.sidecar ?? undefined;
          result = await ctx.ai.run('classify_photo', { filename: docMeta.filename, ...(sidecar ? { metadata: sidecar } : {}) }, { tenantId: tid() });
          return finish(photoExtraction(result, documentId, !!sidecar));
        }
        if (isImage) return finish({ status: 'skipped', fields: [], needsReview: true, summary: 'Image is not a photo kind; no text layer to read' });
        const text = readableText(bytes, ct).trim();
        if (!text) {
          return finish({
            status: 'partial', fields: [], needsReview: true, error: 'no_readable_text',
            summary: 'No readable text found; manual review needed',
          });
        }
        result = await ctx.ai.run('extract_document', {
          ...(docMeta.autoKind ? {} : { kind: row.kind }), text: text.slice(0, TEXT_CAP), filename: docMeta.filename,
        }, { tenantId: tid() });
        const ext = textExtraction(result, documentId);
        if (docMeta.autoKind && KINDS.includes(result.output?.kind) && result.output.kind !== row.kind) {
          ctx.db.update('documents', row.id, { kind: result.output.kind });
        }
        return finish(ext);
      } catch (e) {
        ctx.log.warn('evidence extraction failed', { documentId, error: e?.code ?? e?.name });
        return finish({ status: 'failed', fields: [], needsReview: true, error: 'extraction_failed' });
      }
    },

    /** Accept, correct or reject fields. AI suggests, a person confirms. */
    async reviewExtraction(documentId, decisions, { actor } = {}) {
      const row = docRow(documentId);
      const ext = loadExtraction(documentId);
      if (!Array.isArray(decisions) || !decisions.length) throw new AppError('validation_error', 'fields must be a non-empty array', 400);
      const at = ctx.clock.nowIso();
      for (const d of decisions) {
        if (typeof d?.name !== 'string' || typeof d.accepted !== 'boolean') throw new AppError('validation_error', 'Each field needs name and boolean accepted', 400);
        const f = (ext.fields ?? []).find((x) => x.name === d.name);
        if (!f) throw new AppError('not_found', `No extracted field named ${d.name}`, 404);
        f.accepted = d.accepted;
        if (d.accepted && 'value' in d && d.value !== undefined) {
          f.value = d.value;
          f.normalizedValue = undefined;
        }
        f.provenance = { ...f.provenance, confirmedBy: actorId(actor), confirmedAt: at };
      }
      ctx.db.transaction(() => {
        saveExtraction(ext.id, ext);
        ctx.audit.record({
          actor: actorId(actor), action: 'evidence.extraction.reviewed', entityType: 'document', entityId: documentId,
          details: { claimId: row.claim_id, fields: decisions.map((d) => ({ name: d.name, accepted: d.accepted, corrected: d.value !== undefined })) },
        });
      });
      return ext;
    },

    /** Facts for triage: accepted, or confidence >= 0.8 and not rejected. */
    async getAcceptedFacts(claimId) {
      const facts = {};
      const rank = new Map();
      for (const d of await svc.listDocuments(claimId)) {
        for (const f of d.extraction?.fields ?? []) {
          if (f.accepted === false) continue;
          if (!(f.accepted === true || f.confidence >= HIGH_CONFIDENCE)) continue;
          const score = (f.accepted === true ? 2 : 0) + f.confidence;
          if (rank.has(f.name) && rank.get(f.name) >= score) continue;
          rank.set(f.name, score);
          facts[f.name] = { value: f.value, confidence: f.confidence, provenance: f.provenance };
        }
      }
      return facts;
    },
  };

  function mapField(f, documentId, cap) {
    const confidence = cap === undefined ? clamp(f.confidence) : Math.min(clamp(f.confidence), cap);
    return {
      name: String(f.name), value: f.value, confidence,
      provenance: { source: 'ai_extraction', documentId, ...(f.provenance?.snippet ? { span: String(f.provenance.snippet).slice(0, 300) } : {}) },
      ...(PII_FIELDS.has(f.name) ? { pii: true } : {}),
      accepted: null,
    };
  }

  function aiInfo(r) {
    return { provider: r.provider, model: r.model, confidence: clamp(r.confidence), ...(r.tier !== undefined ? { tier: r.tier } : {}) };
  }

  function textExtraction(r, documentId) {
    const out = r.output ?? {};
    const fields = (out.fields ?? []).map((f) => mapField(f, documentId));
    const needsReview = !!out.needsReview || fields.length === 0;
    return {
      status: needsReview ? 'partial' : 'completed', fields, needsReview, ai: aiInfo(r),
      ...(r.explanation ? { summary: String(r.explanation).slice(0, 500) } : {}),
    };
  }

  function photoExtraction(r, documentId, hasSidecar) {
    const out = r.output ?? {};
    const cap = hasSidecar ? undefined : NO_SIDECAR_CAP;
    const fields = (out.fields ?? []).map((f) => mapField(f, documentId, cap));
    const areas = out.damageAreas ?? [];
    if (areas.length && !fields.some((f) => f.name === 'damageAreas')) {
      fields.push(mapField({ name: 'damageAreas', value: areas, confidence: r.confidence }, documentId, cap));
    }
    const needsReview = !!out.needsReview || !hasSidecar;
    const v = out.vehicle ?? {};
    const vehicle = [v.color, v.make, v.model].filter(Boolean).join(' ');
    return {
      status: needsReview ? 'partial' : 'completed', fields, needsReview, ai: aiInfo(r),
      labels: areas.map((label) => ({ label, confidence: cap === undefined ? clamp(r.confidence) : Math.min(clamp(r.confidence), cap) })),
      summary: `Photo${vehicle ? ` of ${vehicle}` : ''}${areas.length ? `; damage: ${areas.join(', ')}` : ''}`,
    };
  }

  return svc;
}
