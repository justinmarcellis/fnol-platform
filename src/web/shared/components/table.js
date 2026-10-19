import { t } from '../i18n.js';
const HE = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

/** Sort rows by key; numbers numerically, otherwise locale compare. Pure, stable. */
export function sortRows(rows, key, dir = 'asc') {
  if (!key) return [...rows];
  const m = dir === 'desc' ? -1 : 1;
  return rows.map((r, i) => [r, i]).sort(([a, ia], [b, ib]) => {
    const x = a[key]; const y = b[key];
    let c;
    if (x == null && y == null) c = 0; else if (x == null) c = 1; else if (y == null) c = -1;
    else if (typeof x === 'number' && typeof y === 'number') c = x - y;
    else c = String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
    return c * m || ia - ib;
  }).map(([r]) => r);
}

/** Next sort state when a header is activated. Pure. */
export function nextSort(sort, key) {
  return sort?.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
}

/**
 * <fx-table caption> with `.columns=[{key,label,render?,align?,numeric?,sortable?}]` and `.rows=[...]`.
 * `render(row)` may return a string or a DOM Node (e.g. a badge). `numeric`/`align:'end'` right-aligns with tabular figures.
 * `sortable:false` renders a plain header.
 * Sortable headers are buttons (aria-sort). Rows are keyboard focusable; Enter/Space emits fx-select {row}.
 * ArrowUp/Down move between rows.
 */
export class FxTable extends HE {
  constructor() { super(); this._cols = []; this._rows = []; this.sort = null; }
  connectedCallback() { this.render(); }
  get columns() { return this._cols; }
  set columns(v) { this._cols = v ?? []; if (this.isConnected) this.render(); }
  get rows() { return this._rows; }
  set rows(v) { this._rows = v ?? []; if (this.isConnected) this.render(); }
  render() {
    const doc = this.ownerDocument;
    this.textContent = '';
    const rows = sortRows(this._rows, this.sort?.key, this.sort?.dir);
    const table = doc.createElement('table');
    if (this.getAttribute('caption')) { const c = doc.createElement('caption'); c.className = 'fx-visually-hidden'; c.textContent = this.getAttribute('caption'); table.appendChild(c); }
    const thead = doc.createElement('thead'); const hr = doc.createElement('tr');
    for (const col of this._cols) {
      const th = doc.createElement('th'); th.scope = 'col';
      if (col.numeric || col.align === 'end') th.className = 'fx-num';
      if (col.sortable === false) { th.textContent = col.label; hr.appendChild(th); continue; }
      const active = this.sort?.key === col.key;
      th.setAttribute('aria-sort', active ? (this.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      const b = doc.createElement('button'); b.type = 'button'; b.className = 'fx-sort';
      const bl = doc.createElement('span'); bl.textContent = col.label; b.appendChild(bl);
      const arrow = doc.createElement('span'); arrow.className = 'fx-sort-arrow'; arrow.setAttribute('aria-hidden', 'true');
      b.appendChild(arrow); // glyph drawn in CSS from th[aria-sort], so the button text stays the label
      b.setAttribute('aria-label', t('kit.table.sortBy', { column: col.label }));
      b.addEventListener('click', () => { this.sort = nextSort(this.sort, col.key); this.render(); this.querySelector(`th:nth-child(${this._cols.indexOf(col) + 1}) button`)?.focus(); });
      th.appendChild(b); hr.appendChild(th);
    }
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = doc.createElement('tbody');
    if (!rows.length) {
      const tr = doc.createElement('tr'); tr.className = 'fx-table-empty'; const td = doc.createElement('td'); td.colSpan = Math.max(1, this._cols.length); td.textContent = t('kit.table.empty'); tr.appendChild(td); tbody.appendChild(tr);
    }
    rows.forEach((row, i) => {
      const tr = doc.createElement('tr'); tr.tabIndex = 0;
      for (const col of this._cols) {
        const td = doc.createElement('td');
        if (col.numeric || col.align === 'end') td.className = 'fx-num';
        const v = col.render ? col.render(row) : String(row[col.key] ?? '');
        if (v && typeof v === 'object' && typeof v.nodeType === 'number') td.appendChild(v); else td.textContent = v ?? '';
        tr.appendChild(td);
      }
      const select = () => this.dispatchEvent(new CustomEvent('fx-select', { bubbles: true, detail: { row } }));
      tr.addEventListener('click', select);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); tbody.children[i + 1]?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); tbody.children[i - 1]?.focus(); }
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    this.appendChild(table);
    const live = doc.createElement('div'); live.className = 'fx-visually-hidden'; live.setAttribute('aria-live', 'polite');
    live.textContent = t('kit.table.rowCount', { count: rows.length });
    this.appendChild(live);
  }
}
