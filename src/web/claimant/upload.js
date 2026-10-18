// Evidence upload: validation and an uploader that posts to /claims/{id}/documents.
// Pure logic; inject { api }. FormData/File/Blob are Node 22 globals, so tests need no DOM.

export const MAX_BYTES = 15 * 1024 * 1024;
export const KINDS = ['photo', 'police_report', 'estimate', 'invoice', 'other'];
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
export const ACCEPT_ATTR = ACCEPTED_TYPES.join(',');

/**
 * @param {{ name: string, size: number, type: string }} file
 * @returns {{ ok: true } | { ok: false, code: 'tooLarge' | 'badType' | 'empty' }}
 */
export function validateFile(file) {
  if (!file || !file.size) return { ok: false, code: 'empty' };
  if (file.size > MAX_BYTES) return { ok: false, code: 'tooLarge' };
  if (!ACCEPTED_TYPES.includes(file.type)) return { ok: false, code: 'badType' };
  return { ok: true };
}

/** Default document kind for a file. */
export function guessKind(file) {
  return String(file?.type ?? '').startsWith('image/') ? 'photo' : 'other';
}

/**
 * @param {{ api: any, claimId: string }} deps
 */
export function createUploader({ api, claimId }) {
  const listeners = new Set();
  /** @type {{ id: string, name: string, kind: string, status: 'uploading'|'done'|'error'|'rejected', code?: string, message?: string, document?: any, file: any }[]} */
  const items = [];
  let seq = 0;
  const view = () => items.map(({ file, ...rest }) => rest);
  const emit = () => { const v = view(); for (const l of listeners) l(v); };

  async function send(item, description) {
    item.status = 'uploading'; item.code = undefined; item.message = undefined; emit();
    try {
      const form = new FormData();
      form.append('file', item.file, item.name);
      form.append('kind', item.kind);
      if (description) form.append('description', description);
      item.document = await api.upload(`/claims/${claimId}/documents`, form);
      item.status = 'done';
    } catch (err) {
      item.status = 'error';
      item.code = err?.code ?? 'error';
      item.message = err?.message ?? String(err);
    }
    emit();
    return item;
  }

  return {
    get items() { return view(); },
    subscribe(fn) { listeners.add(fn); fn(view()); return () => listeners.delete(fn); },
    /** Validate then upload a file sequentially. Rejected files are listed, not sent. */
    async add(file, kind = guessKind(file), description) {
      const item = { id: `u${++seq}`, name: file?.name ?? 'file', kind, status: 'uploading', file };
      items.push(item);
      const v = validateFile(file);
      if (!v.ok) { item.status = 'rejected'; item.code = v.code; emit(); return item; }
      return send(item, description);
    },
    async addAll(files, kind) { for (const f of files) await this.add(f, kind ?? guessKind(f)); },
    async retry(id) {
      const item = items.find((i) => i.id === id);
      return item && item.status === 'error' ? send(item) : null;
    }
  };
}
