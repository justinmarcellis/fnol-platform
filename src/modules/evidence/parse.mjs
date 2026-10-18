// Pure helpers: multipart parsing, PDF text scan, kind detection. No ctx access.
import zlib from 'node:zlib';
import { AppError } from '../../core/errors.mjs';

export const KINDS = ['photo', 'police_report', 'estimate', 'invoice', 'other'];
export const MAX_BYTES = 10 * 1024 * 1024;
export const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif',
  'application/pdf', 'text/plain',
];

/** Default per-upload cap; tenants override via config.evidence.maxUploadBytes. */
export const DEFAULT_MAX_BYTES = MAX_BYTES;

/**
 * Detect the real content type from magic bytes. Returns one of ALLOWED_TYPES, or null when unrecognised.
 * @param {Buffer} bytes
 */
export function sniffContentType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  const head6 = b.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp'
    && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(b.subarray(8, 12).toString('latin1'))) return 'image/heic';
  if (b.subarray(0, 1024).toString('latin1').includes('%PDF-')) return 'application/pdf';
  // text/plain: no NUL or other control bytes, and valid UTF-8
  const sample = b.subarray(0, 8192);
  for (const c of sample) if (c === 0 || (c < 9) || (c > 13 && c < 32)) return null;
  try { new TextDecoder('utf-8', { fatal: true }).decode(b.length > 65536 ? b.subarray(0, 65536) : b); } catch { return null; }
  return 'text/plain';
}

/** Strip parameters and lowercase a content type. */
export const baseType = (ct) => String(ct ?? '').split(';')[0].trim().toLowerCase();

/** Multipart DoS caps (S4-AI-02): part count and total parse time. */
export const MAX_MULTIPART_PARTS = 20;
export const MAX_MULTIPART_MS = 100;

/**
 * Minimal, binary-safe multipart/form-data parser.
 * @param {Buffer} buf raw body
 * @param {string} contentType header value (must carry boundary)
 * @returns {{name: string, filename?: string, contentType?: string, data: Buffer}[]}
 */
export function parseMultipart(buf, contentType) {
  const deadline = performance.now() + MAX_MULTIPART_MS;
  const tooMany = () => new AppError('validation_error', `Multipart body is limited to ${MAX_MULTIPART_PARTS} parts`, 400);
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType ?? ''));
  if (!m) return null;
  const delim = Buffer.from(`--${m[1] ?? m[2]}`);
  const parts = [];
  let pos = buf.indexOf(delim);
  let seen = 0;
  while (pos !== -1) {
    // every delimiter counts, named or not, so empty parts cannot be used to spin the loop
    if (++seen > MAX_MULTIPART_PARTS + 1) throw tooMany();
    if (performance.now() > deadline) throw new AppError('validation_error', 'Multipart body took too long to parse', 400);
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
      if (name !== undefined && parts.length >= MAX_MULTIPART_PARTS) throw tooMany();
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

// Limits for the PDF text scan (SEC2-005). Every loop below advances a cursor; nothing backtracks.
export const MAX_STREAMS = 200;
export const MAX_SCAN_BYTES = 12 * 1024 * 1024;
export const MAX_INFLATE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_INFLATE_BYTES = 16 * 1024 * 1024;
export const SCAN_BUDGET_MS = 100;
const MAX_LINES = 5000;
export const MAX_SECTION_PARTS = 2000; // strings per BT..ET section
export const MAX_SECTION_CHARS = 256 * 1024; // chars scanned per BT..ET section
const CHECK_EVERY = 256; // iterations between performance.now() checks

const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;

/** Read a PDF literal string starting after '(' at i. Returns { text, end } (end is index after ')'), or null. */
function readString(s, i) {
  let depthless = i;
  while (depthless < s.length) {
    const c = s.charCodeAt(depthless);
    if (c === 92) depthless += 2; // backslash escape
    else if (c === 41) return { text: s.slice(i, depthless), end: depthless + 1 };
    else depthless++;
  }
  return null;
}

function skipWs(s, i) {
  while (i < s.length && isWs(s.charCodeAt(i))) i++;
  return i;
}

/** Linear tokenizer for one BT..ET section: (text) Tj and [(a) 10 (b)] TJ. */
function scanSection(sec, lines, deadline) {
  let i = 0;
  let ticks = 0;
  let strings = 0;
  const n = sec.length;
  while (i < n && lines.length < MAX_LINES) {
    if ((++ticks & (CHECK_EVERY - 1)) === 0 && performance.now() > deadline) return;
    const c = sec.charCodeAt(i);
    if (c === 40) { // (
      const str = readString(sec, i + 1);
      if (!str) return;
      if (++strings > MAX_SECTION_PARTS) return;
      const j = skipWs(sec, str.end);
      if (sec.charCodeAt(j) === 84 && sec.charCodeAt(j + 1) === 106) { lines.push(unescapePdf(str.text)); i = j + 2; } else i = str.end;
    } else if (c === 91) { // [
      let j = i + 1;
      const parts = [];
      let closed = false;
      while (j < n) {
        if ((++ticks & (CHECK_EVERY - 1)) === 0 && performance.now() > deadline) return;
        const d = sec.charCodeAt(j);
        if (d === 40) {
          const str = readString(sec, j + 1);
          if (!str || ++strings > MAX_SECTION_PARTS) return;
          parts.push(unescapePdf(str.text));
          j = str.end;
        } else if (d === 93) { closed = true; j++; break; } else j++;
      }
      if (!closed) return;
      const k = skipWs(sec, j);
      if (sec.charCodeAt(k) === 84 && sec.charCodeAt(k + 1) === 74) { lines.push(parts.join('')); i = k + 2; } else i = j;
    } else i++;
  }
}

/** Find BT..ET sections with indexOf only. */
function scanContent(content, lines, deadline) {
  let pos = 0;
  let ticks = 0;
  while (pos < content.length && lines.length < MAX_LINES) {
    if ((++ticks & (CHECK_EVERY - 1)) === 1 && performance.now() > deadline) return;
    const bt = content.indexOf('BT', pos);
    if (bt === -1) return;
    const et = content.indexOf('ET', bt + 2);
    if (et === -1) return; // unterminated: nothing later can terminate either
    scanSection(content.slice(bt + 2, Math.min(et, bt + 2 + MAX_SECTION_CHARS)), lines, deadline);
    pos = et + 2;
  }
}

/**
 * Best-effort text from a simple PDF: uncompressed text objects, plus Flate streams that inflate.
 * Bounded: stream count, scanned bytes, inflate size and wall-clock. Returns a partial result, never throws.
 * @param {Buffer} bytes
 * @returns {string} '' when nothing readable
 */
export function extractPdfText(bytes) {
  const hit = Buffer.isBuffer(bytes) ? pdfTextCache.get(bytes) : undefined;
  if (hit !== undefined) return hit;
  const out = extractPdfTextUncached(bytes);
  if (Buffer.isBuffer(bytes)) pdfTextCache.set(bytes, out);
  return out;
}

// extract()/readableText() are called several times per upload on the same Buffer; scan once.
const pdfTextCache = new WeakMap();

function extractPdfTextUncached(bytes) {
  const lines = [];
  try {
    const deadline = performance.now() + SCAN_BUDGET_MS;
    const buf = bytes.length > MAX_SCAN_BYTES ? bytes.subarray(0, MAX_SCAN_BYTES) : bytes;
    scanContent(buf.toString('latin1'), lines, deadline);
    let pos = 0;
    let streams = 0;
    let inflatedTotal = 0;
    while (streams < MAX_STREAMS && lines.length < MAX_LINES && performance.now() < deadline) {
      const k = buf.indexOf('stream', pos);
      if (k === -1) break;
      pos = k + 6;
      if (k >= 3 && buf.toString('latin1', k - 3, k) === 'end') continue; // "endstream"
      let start = k + 6;
      if (buf[start] === 13) start++;
      if (buf[start] !== 10) continue;
      start++;
      const end = buf.indexOf('endstream', start);
      if (end === -1) break;
      pos = end + 9;
      streams++;
      let stop = end;
      if (stop > start && buf[stop - 1] === 10) stop--;
      if (stop > start && buf[stop - 1] === 13) stop--;
      if (stop <= start || inflatedTotal >= MAX_TOTAL_INFLATE_BYTES) continue;
      try {
        const out = zlib.inflateSync(buf.subarray(start, stop), { maxOutputLength: MAX_INFLATE_BYTES });
        inflatedTotal += out.length;
        scanContent(out.toString('latin1'), lines, deadline);
      } catch { /* not Flate, invalid, or over the output limit (RangeError): skip this stream */ }
    }
  } catch { /* partial result */ }
  return lines.map((l) => l.trim()).filter(Boolean).join('\n');
}

/**
 * Grand total of an estimate or invoice: a labelled grand total wins over the parts subtotal;
 * otherwise parts + labor + tax (+ paint/materials/sublet) when parts is present. Returns a number or undefined.
 * @param {string} text
 */
export function extractEstimateGrandTotal(text) {
  const t = String(text ?? '').slice(0, 200000);
  const amount = '\\$?\\s{0,3}(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d{1,9}(?:\\.\\d{1,2})?)';
  const num = (s) => Number(s.replace(/,/g, ''));
  // last labelled grand total wins (totals sit at the bottom)
  const labelled = [...t.matchAll(new RegExp(`(?:grand[ \\t]+total|total[ \\t]+due|amount[ \\t]+due|total[ \\t]+amount[ \\t]+due|balance[ \\t]+due)[ \\t]{0,3}[:\\-]?[ \\t]{0,3}${amount}`, 'gi'))];
  if (labelled.length) return num(labelled.at(-1)[1]);
  const pick = (label) => {
    const m = [...t.matchAll(new RegExp(`${label}[ \\t]{0,3}(?:total|subtotal)?[ \\t]{0,3}[:\\-]?[ \\t]{0,3}${amount}`, 'gi'))];
    return m.length ? num(m.at(-1)[1]) : undefined;
  };
  const parts = pick('parts');
  if (parts === undefined) return undefined;
  return Math.round([parts, pick('labor'), pick('paint'), pick('sublet'), pick('tax')].reduce((a, v) => a + (v ?? 0), 0) * 100) / 100;
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
