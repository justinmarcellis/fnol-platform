// Pure helpers: multipart parsing, PDF text scan, kind detection. No ctx access.
import zlib from 'node:zlib';

export const KINDS = ['photo', 'police_report', 'estimate', 'invoice', 'other'];
export const MAX_BYTES = 10 * 1024 * 1024;
export const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif',
  'application/pdf', 'text/plain',
];

/** Strip parameters and lowercase a content type. */
export const baseType = (ct) => String(ct ?? '').split(';')[0].trim().toLowerCase();

/**
 * Minimal, binary-safe multipart/form-data parser.
 * @param {Buffer} buf raw body
 * @param {string} contentType header value (must carry boundary)
 * @returns {{name: string, filename?: string, contentType?: string, data: Buffer}[]}
 */
export function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType ?? ''));
  if (!m) return null;
  const delim = Buffer.from(`--${m[1] ?? m[2]}`);
  const parts = [];
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    let chunk = buf.slice(start, next);
    if (chunk.slice(0, 2).toString() === '\r\n') chunk = chunk.slice(2);
    if (chunk.slice(-2).toString() === '\r\n') chunk = chunk.slice(0, -2);
    const sep = chunk.indexOf('\r\n\r\n');
    if (sep !== -1) {
      const headers = {};
      for (const line of chunk.slice(0, sep).toString('utf8').split('\r\n')) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const disp = headers['content-disposition'] ?? '';
      const name = /\bname="([^"]*)"/i.exec(disp)?.[1];
      const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
      if (name !== undefined) parts.push({ name, filename, contentType: headers['content-type'], data: chunk.slice(sep + 4) });
    }
    pos = next;
  }
  return parts;
}

function unescapePdf(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => {
    if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] ?? c;
  });
}

function scanContent(content) {
  const lines = [];
  for (const bt of content.matchAll(/BT([\s\S]*?)ET/g)) {
    for (const op of bt[1].matchAll(/\[((?:\\.|[^\]\\])*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
      if (op[2] !== undefined) lines.push(unescapePdf(op[2]));
      else lines.push([...op[1].matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((x) => unescapePdf(x[1])).join(''));
    }
  }
  return lines;
}

/**
 * Best-effort text from a simple PDF: uncompressed text objects, plus Flate streams that inflate.
 * @param {Buffer} bytes
 * @returns {string} '' when nothing readable
 */
export function extractPdfText(bytes) {
  const raw = bytes.toString('latin1');
  const lines = scanContent(raw);
  for (const s of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      const inflated = zlib.inflateSync(Buffer.from(s[1], 'latin1')).toString('latin1');
      lines.push(...scanContent(inflated));
    } catch { /* not Flate or not valid: ignore */ }
  }
  return lines.map((l) => l.trim()).filter(Boolean).join('\n');
}

/** Decode the readable text of a document, or '' (images, unreadable PDFs). */
export function readableText(bytes, contentType) {
  const t = baseType(contentType);
  if (t === 'text/plain') return bytes.toString('utf8');
  if (t === 'application/pdf') return extractPdfText(bytes);
  return '';
}

/** Guess the document kind from content type, filename and (optional) text. */
export function detectKind({ filename = '', contentType = '', text = '' }) {
  if (baseType(contentType).startsWith('image/')) return 'photo';
  const hay = `${filename} ${text.slice(0, 4000)}`.toLowerCase();
  if (/police|incident report|accident report|officer|citation/.test(hay)) return 'police_report';
  if (/estimate|appraisal|repair quote|body shop/.test(hay)) return 'estimate';
  if (/invoice|amount due|bill to|receipt/.test(hay)) return 'invoice';
  return 'other';
}
