// Writes dashboard/snapshot.html: one self-contained read-only HTML file.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from './server.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));

/** Build the self-contained HTML string. */
export function renderSnapshotHtml(data = build()) {
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8');
  const js = readFileSync(join(DIR, 'app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  let html = readFileSync(join(DIR, 'index.html'), 'utf8');
  html = html.replace(/<link[^>]*styles\.css[^>]*>/, () => `<style>${css}</style>`);
  html = html.replace(/<script[^>]*src="app\.js"[^>]*><\/script>/, () =>
    `<script>window.__SNAPSHOT__=${safeJson(data)};</script>\n<script>${js}</script>`);
  return html;
}

/** Write the snapshot file and return its path. */
export function exportSnapshot(out = join(DIR, 'snapshot.html')) {
  writeFileSync(out, renderSnapshotHtml());
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) console.log(`wrote ${exportSnapshot()}`);
