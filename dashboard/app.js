// PMO dashboard UI. Data comes from /api/snapshot + /api/metrics, or window.__SNAPSHOT__ in the exported file.
(function () {
  const TABS = ['Overview', 'Org chart', 'Decision network', 'Sprint board', 'Velocity & forecast', 'Quality', 'Flow', 'Cost', 'Performance', 'Agent rank', 'Sprint review', 'Value drivers', 'Improvement log'];
  const STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done', 'blocked'];
  const state = { tab: 0, team: '', data: null, error: null, net: { kinds: ['msg', 'ticket', 'review', 'run'], team: '' }, source: 'snapshot', at: null, sig: '', board: { sprint: '', team: '' } };
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? 'n/a' : typeof v === 'number' ? String(Math.round(v * 10 ** d) / 10 ** d) : esc(v));
  const pct = (v) => (v === null || v === undefined ? 'n/a' : Math.round(v * 1000) / 10 + '%');
  const usd = (v) => (v === null || v === undefined ? 'n/a' : '$' + Number(v).toFixed(2));
  const kpi = (l, v, cls) => `<div class="card kpi"><div class="l">${esc(l)}</div><div class="v ${cls || ''}">${v}</div></div>`;
  const badge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;
  const empty = (t) => `<div class="empty">${esc(t)}</div>`;
  const table = (heads, rows) => rows.length
    ? `<div class="scroll"><table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty('No data yet.');

  // ---- charts (inline SVG) ----
  function barChart(rows) {
    if (!rows.length) return empty('No sprints yet.');
    const W = 480, H = 220, p = { l: 36, r: 8, t: 10, b: 28 };
    const max = Math.max(1, ...rows.flatMap((r) => [r.committed, r.completed]));
    const bw = (W - p.l - p.r) / rows.length;
    const y = (v) => H - p.b - (v / max) * (H - p.t - p.b);
    const bars = rows.map((r, i) => {
      const x = p.l + i * bw + bw * 0.12, w = bw * 0.36;
      return `<rect class="s1" x="${x}" y="${y(r.committed)}" width="${w}" height="${H - p.b - y(r.committed)}" opacity=".55"><title>Sprint ${esc(r.sprint)} committed ${r.committed}</title></rect>
        <rect class="s2" x="${x + w + 2}" y="${y(r.completed)}" width="${w}" height="${H - p.b - y(r.completed)}"><title>Sprint ${esc(r.sprint)} completed ${r.completed}</title></rect>
        <text x="${x + w}" y="${H - 10}" text-anchor="middle">S${esc(r.sprint)}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Committed vs completed points per sprint"><line class="axis" x1="${p.l}" x2="${W - p.r}" y1="${H - p.b}" y2="${H - p.b}"/>
      <text x="${p.l - 4}" y="${y(max) + 4}" text-anchor="end">${max}</text><text x="${p.l - 4}" y="${H - p.b}" text-anchor="end">0</text>${bars}</svg>
      <div class="legend"><i class="s1" style="opacity:.55"></i>committed<i class="s2"></i>completed</div>`;
  }
  function lineChart(series, key, committed) {
    if (!series.length) return empty('No burndown data yet.');
    const W = 480, H = 220, p = { l: 36, r: 12, t: 10, b: 28 };
    const t = series.map((s) => Date.parse(s.at));
    const t0 = Math.min(...t), t1 = Math.max(...t, t0 + 1);
    const max = Math.max(1, committed, ...series.map((s) => s[key]));
    const x = (v) => p.l + ((v - t0) / (t1 - t0)) * (W - p.l - p.r);
    const y = (v) => H - p.b - (v / max) * (H - p.t - p.b);
    const pts = series.map((s, i) => `${x(t[i]).toFixed(1)},${y(s[key]).toFixed(1)}`).join(' ');
    const dots = series.map((s, i) => `<circle class="s1" r="3" cx="${x(t[i])}" cy="${y(s[key])}"><title>${esc(s.at)}: ${s[key]}${s.ticket ? ' (' + esc(s.ticket) + ')' : ''}</title></circle>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(key)} over time"><line class="axis" x1="${p.l}" x2="${W - p.r}" y1="${H - p.b}" y2="${H - p.b}"/>
      <line class="ideal" x1="${x(t0)}" y1="${y(committed)}" x2="${x(t1)}" y2="${y(0)}"/>
      <polyline class="line s1" points="${pts}"/>${dots}<text x="${p.l - 4}" y="${y(max) + 4}" text-anchor="end">${max}</text><text x="${p.l - 4}" y="${H - p.b}" text-anchor="end">0</text>
      <text x="${p.l}" y="${H - 10}">${esc(new Date(t0).toLocaleDateString())}</text><text x="${W - p.r}" y="${H - 10}" text-anchor="end">${esc(new Date(t1).toLocaleDateString())}</text></svg>`;
  }
  const hbars = (obj, fmtFn) => {
    const e = Object.entries(obj || {});
    if (!e.length) return empty('No data yet.');
    const max = Math.max(1e-9, ...e.map(([, v]) => v));
    return `<svg viewBox="0 0 480 ${e.length * 24 + 6}" role="img">${e.map(([k, v], i) => `<text x="0" y="${i * 24 + 16}">${esc(k)}</text><rect class="s1" x="110" y="${i * 24 + 5}" width="${(v / max) * 280}" height="14" rx="2"/><text x="${116 + (v / max) * 280}" y="${i * 24 + 16}">${esc(fmtFn(v))}</text>`).join('')}</svg>`;
  };

  function tierMix(mix) {
    const tiers = (mix && mix.tiers) || [];
    if (!tiers.length || !mix.totalUsd) return empty('No tier spend yet.');
    return `<div class="stack" role="img" aria-label="Spend share by model tier">${tiers.filter((t) => t.pct > 0).map((t, i) => `<span class="seg c${i % 4}" style="width:${t.pct}%" title="${esc(t.tier)} ${t.pct}%"></span>`).join('')}</div>`
      + table(['Tier', 'Spend', 'Share', 'Tickets', 'Points'], tiers.map((t) => [esc(t.tier), usd(t.usd), t.pct + '%', t.tickets, t.points]));
  }
  const list = (a) => (Array.isArray(a) && a.length ? `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">None recorded.</p>');


  // ---- decision network (canvas: force layout, event pulses, replay; no dependencies) ----
  const NET_KINDS = { msg: 'message', ticket: 'ticket move', review: 'review verdict', run: 'agent run' };
  const KIND_COLOR = { msg: '#7fd3e3', ticket: '#b8c7d2', review: '#7ee0a0', run: '#f0c46b' };
  const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };
  const teamHue = (t) => Math.round(hash('team:' + (t || 'none')) * 360);
  const teamColor = (t) => `hsl(${teamHue(t)} 62% 62%)`;
  const LW = 900, LH = 620, RECENT = 6 * 60 * 1000, PULSE_MS = 1400;
  // Persisted across live updates and tab switches so a refresh never resets the replay.
  const net = { cursor: 0, playing: false, follow: true, speed: 3, pos: new Map(), key: '', events: [], nodes: [], links: [], byId: new Map(), pulses: [], tMin: 0, tMax: 0, hover: null, raf: 0, last: 0, canvas: null, w: 0, h: 0, started: false };

  const nodeR = (n) => 3 + Math.sqrt(n.activity || 0) * (n.kind === 'hub' ? 1.6 : 1.1);
  /** Small deterministic force layout in a fixed LW x LH space: repulsion, link springs, team anchors, collision. */
  function layoutNet(nodes, links) {
    const teams = [...new Set(nodes.map((n) => n.team).filter(Boolean))].sort();
    const ang = (t) => (Math.max(0, teams.indexOf(t)) / Math.max(teams.length, 1)) * Math.PI * 2;
    const anchor = (n) => (n.kind === 'orchestrator' ? [LW / 2, LH / 2] : [LW / 2 + Math.cos(ang(n.team)) * LW * 0.28, LH / 2 + Math.sin(ang(n.team)) * LH * 0.3]);
    for (const n of nodes) {
      const old = net.pos.get(n.id);
      if (old) { n.x = old.x; n.y = old.y; } else {
        const a = ang(n.team) + (hash(n.id) - 0.5) * 0.9, rad = n.kind === 'orchestrator' ? 0 : n.kind === 'hub' ? LH * 0.2 : LH * 0.34;
        n.x = LW / 2 + Math.cos(a) * rad + (hash('x' + n.id) - 0.5) * 30; n.y = LH / 2 + Math.sin(a) * rad + (hash('y' + n.id) - 0.5) * 30;
      }
      n.vx = 0; n.vy = 0; n.r = nodeR(n);
    }
    const warm = nodes.some((n) => net.pos.has(n.id));
    const iters = warm ? 60 : 280;
    for (let it = 0; it < iters; it++) {
      const alpha = (warm ? 0.3 : 1) * (1 - it / iters);
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = hash(a.id + b.id) - 0.5; dy = 0.5 - hash(b.id + a.id); d2 = 0.5; }
          const d = Math.sqrt(d2);
          const q = (a.kind === 'hub' || b.kind === 'hub' ? 260 : 90) * alpha / d2;
          const min = a.r + b.r + 3, push = d < min ? (min - d) * 0.5 : 0;
          const fx = (dx / d) * (q + push), fy = (dy / d) * (q + push);
          a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
        }
      }
      for (const l of links) {
        const a = l.s, b = l.t; const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const k = (d - (40 + 60 / Math.sqrt(l.count))) * Math.min(1, 0.05 + l.count / 40) * 0.1 * alpha;
        a.vx += (dx / d) * k; a.vy += (dy / d) * k; b.vx -= (dx / d) * k; b.vy -= (dy / d) * k;
      }
      for (const n of nodes) {
        const [ax, ay] = anchor(n); n.vx += (ax - n.x) * 0.06 * alpha; n.vy += (ay - n.y) * 0.06 * alpha;
        n.x = Math.max(n.r + 6, Math.min(LW - n.r - 6, n.x + n.vx * 0.6)); n.y = Math.max(n.r + 30, Math.min(LH - n.r - 6, n.y + n.vy * 0.6));
        n.vx *= 0.5; n.vy *= 0.5;
      }
    }
    for (const n of nodes) net.pos.set(n.id, { x: n.x, y: n.y });
  }

  function netData(d) {
    const g = d.graph || (d.snapshot && d.snapshot.graph);
    const items = (d.events && d.events.items) || (Array.isArray(d.events) ? d.events : []);
    return { g, items };
  }
  /** (Re)build nodes, links and the timeline from the current documents. Keeps cursor, play state and node positions. */
  function setNetData(d) {
    const { g, items } = netData(d);
    const prevMax = net.tMax;
    net.nodes = g.nodes.map((n) => ({ ...n }));
    net.byId = new Map(net.nodes.map((n) => [n.id, n]));
    net.links = g.edges.filter((e) => net.byId.has(e.source) && net.byId.has(e.target)).map((e) => ({ ...e, s: net.byId.get(e.source), t: net.byId.get(e.target) }));
    net.events = items.map((e) => ({ ...e, ts: Date.parse(e.t), k: String(e.kind).split(':')[0] })).filter((e) => !Number.isNaN(e.ts)).sort((a, b) => a.ts - b.ts);
    net.tMin = net.events.length ? net.events[0].ts : 0; net.tMax = net.events.length ? net.events[net.events.length - 1].ts : 0;
    const key = net.nodes.map((n) => n.id).sort().join('|');
    if (key !== net.key || !net.nodes.every((n) => net.pos.has(n.id))) layoutNet(net.nodes, net.links);
    else for (const n of net.nodes) { const p = net.pos.get(n.id); n.x = p.x; n.y = p.y; n.r = nodeR(n); }
    net.key = key;
    if (!net.cursor || net.follow) net.cursor = net.tMax;
    if (prevMax && net.follow && net.started) for (const e of net.events) if (e.ts > prevMax) spawnPulse(e);
    net.started = true;
  }
  function spawnPulse(e) {
    if (!state.net.kinds.includes(e.k)) return;
    const a = net.byId.get(e.from), b = net.byId.get(e.to);
    if (!a || !b) return;
    net.pulses.push({ a, b, k: e.k, born: performance.now() });
    if (net.pulses.length > 300) net.pulses.splice(0, net.pulses.length - 300);
  }

  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const fmtT = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  function netSize() {
    const cv = net.canvas, r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    net.w = r.width || 900; net.h = r.height || 560;
    cv.width = Math.round(net.w * dpr); cv.height = Math.round(net.h * dpr);
    cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  // Fit the laid-out nodes to the canvas (padding for labels), whatever the canvas shape.
  const fit = () => { const xs = net.nodes.map((n) => n.x), ys = net.nodes.map((n) => n.y); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };
  let bb = null;
  const px = (n) => 30 + (n.x - bb.x0) / Math.max(1, bb.x1 - bb.x0) * (net.w - 60);
  const py = (n) => 40 + (n.y - bb.y0) / Math.max(1, bb.y1 - bb.y0) * (net.h - 70);
  function drawNet(now) {
    const cv = net.canvas, ctx = cv.getContext('2d'), cur = net.cursor, kinds = state.net.kinds, team = state.net.team;
    ctx.clearRect(0, 0, net.w, net.h);
    if (!net.nodes.length) return;
    bb = fit();
    const lastByEdge = new Map();
    for (const e of net.events) { if (e.ts > cur) break; if (kinds.includes(e.k)) lastByEdge.set(e.from + '|' + e.to, e.ts); }
    const dimmed = (n) => team && n.team !== team;
    let lit = 0, visibleEdges = 0;
    for (const l of net.links) {
      const last = lastByEdge.get(l.source + '|' + l.target);
      if (!last) continue;
      visibleEdges++;
      const fresh = Math.max(0, 1 - (cur - last) / RECENT);
      ctx.globalAlpha = dimmed(l.s) && dimmed(l.t) ? 0.15 : 1;
      ctx.strokeStyle = fresh > 0 ? `rgba(127,211,227,${0.3 + 0.6 * fresh})` : 'rgba(130,150,165,.28)';
      ctx.lineWidth = Math.min(4, 0.5 + Math.log2(1 + l.count) * 0.5) + fresh * 1.5;
      ctx.beginPath(); ctx.moveTo(px(l.s), py(l.s)); ctx.lineTo(px(l.t), py(l.t)); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    net.pulses = net.pulses.filter((p) => now - p.born < PULSE_MS);
    for (const p of net.pulses) {
      const k = (now - p.born) / PULSE_MS, x = px(p.a) + (px(p.b) - px(p.a)) * k, y = py(p.a) + (py(p.b) - py(p.a)) * k;
      ctx.fillStyle = KIND_COLOR[p.k] || '#fff'; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    }
    const act = new Set(((netData(state.data).g || {}).active || []).map((a) => a.owner));
    const ink = cssVar('--net-ink') || '#dfe8ee';
    for (const n of net.nodes) {
      const lastTs = n.lastAt ? Date.parse(n.lastAt) : 0, on = (lastTs && lastTs <= cur && cur - lastTs < RECENT) || act.has(n.id);
      if (on) lit++;
      const x = px(n), y = py(n), c = n.kind === 'orchestrator' ? '#e3b341' : teamColor(n.team);
      ctx.globalAlpha = dimmed(n) ? 0.2 : 1;
      ctx.fillStyle = n.kind === 'hub' ? 'rgba(223,232,238,.1)' : c; ctx.strokeStyle = n.kind === 'hub' ? c : 'rgba(13,20,27,.9)'; ctx.lineWidth = n.kind === 'hub' ? 2.5 : 1;
      if (on) { ctx.shadowColor = c; ctx.shadowBlur = 18; }
      ctx.beginPath(); ctx.arc(x, y, n.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
      if (n.kind === 'hub' || n.kind === 'orchestrator' || n === net.hover || (n.activity > 40 && !dimmed(n))) {
        ctx.fillStyle = ink; ctx.font = (n.kind === 'hub' ? '600 ' : '') + '11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center';
        const label = n.id.replace('hub:', '#'), half = ctx.measureText(label).width / 2;
        ctx.fillText(label, Math.max(half + 4, Math.min(net.w - half - 4, x)), y - n.r - 5);
      }
    }
    ctx.globalAlpha = 1;
    const clock = document.getElementById('netclock');
    if (clock) clock.textContent = 'Timeline: ' + (cur ? fmtT(cur) : 'n/a') + (net.playing ? ' (replaying)' : net.follow ? ' (live)' : '');
    cv.dataset.cursor = String(Math.round(cur)); cv.dataset.tmin = String(net.tMin); cv.dataset.tmax = String(net.tMax); cv.dataset.pulses = String(net.pulses.length); cv.dataset.playing = String(net.playing);
    cv.dataset.nodes = String(net.nodes.length); cv.dataset.edges = String(visibleEdges); cv.dataset.lit = String(lit);
  }
  function setScrub() {
    const s = document.getElementById('scrub'); if (!s) return;
    const span = Math.max(1, net.tMax - net.tMin); s.value = String(Math.round(1000 * (net.cursor - net.tMin) / span));
  }
  function setPlayButton() {
    const b = document.getElementById('play'); if (!b) return;
    b.textContent = net.playing ? 'Pause' : 'Replay'; b.setAttribute('aria-pressed', String(net.playing));
  }
  function netFrame(now) {
    if (!net.canvas || !net.canvas.isConnected) { net.raf = 0; return; }
    const dt = Math.min(100, now - (net.last || now)); net.last = now;
    if (net.playing) {
      const span = Math.max(1, net.tMax - net.tMin), prev = net.cursor;
      net.cursor = Math.min(net.tMax, net.cursor + dt * (span / 90000) * net.speed);
      for (const e of net.events) { if (e.ts > net.cursor) break; if (e.ts > prev) spawnPulse(e); }
      if (net.cursor >= net.tMax) { net.playing = false; setPlayButton(); }
      setScrub();
    }
    drawNet(now);
    net.raf = requestAnimationFrame(netFrame);
  }
  function stopFollow() { net.follow = false; const f = document.getElementById('follow'); if (f) f.checked = false; }
  function stepEvent(dir) {
    let e = null;
    if (dir > 0) e = net.events.find((x) => x.ts > net.cursor);
    else for (let i = net.events.length - 1; i >= 0; i--) if (net.events[i].ts < net.cursor) { e = net.events[i]; break; }
    if (!e) return;
    net.cursor = e.ts; net.playing = false; stopFollow(); setPlayButton(); setScrub(); spawnPulse(e);
  }
  function tooltip(x, y) {
    if (!bb) return;
    const tip = document.getElementById('nettip'); if (!tip) return;
    const n = net.nodes.find((m) => (px(m) - x) ** 2 + (py(m) - y) ** 2 < (m.r + 5) ** 2);
    net.hover = n || null;
    if (!n) { tip.hidden = true; return; }
    const out = net.links.filter((l) => l.s === n).sort((a, b) => b.count - a.count).slice(0, 3).map((l) => '→ ' + l.t.id + ' (' + l.count + ')');
    const inn = net.links.filter((l) => l.t === n).sort((a, b) => b.count - a.count).slice(0, 3).map((l) => '← ' + l.s.id + ' (' + l.count + ')');
    tip.innerHTML = `<b>${esc(n.id)}</b><div>${esc(n.kind)}${n.team ? ' · ' + esc(n.team) : ''} · ${n.activity} events${n.lastAt ? ' · last ' + esc(fmtT(Date.parse(n.lastAt))) : ''}</div>${[...out, ...inn].map((t) => `<div>${esc(t)}</div>`).join('')}`;
    tip.hidden = false; tip.style.left = Math.max(4, Math.min(x + 14, net.w - 280)) + 'px'; tip.style.top = Math.max(4, Math.min(y + 14, net.h - 130)) + 'px';
  }
  /** Wire the freshly rendered Decision network tab to the persistent net state. */
  function mountNet(d) {
    const cv = document.getElementById('netcanvas'); if (!cv || typeof cv.getContext !== 'function') return; // no canvas (non-browser host)
    net.canvas = cv; setNetData(d); netSize(); setScrub(); setPlayButton();
    const $q = (id) => document.getElementById(id);
    $q('play').onclick = () => {
      net.playing = !net.playing;
      if (net.playing) { if (net.cursor >= net.tMax) net.cursor = net.tMin; stopFollow(); }
      setPlayButton(); setScrub();
    };
    $q('scrub').oninput = (e) => { net.cursor = net.tMin + (net.tMax - net.tMin) * Number(e.target.value) / 1000; net.playing = false; stopFollow(); setPlayButton(); };
    $q('speed').onchange = (e) => { net.speed = Number(e.target.value); };
    $q('follow').onchange = (e) => { net.follow = e.target.checked; if (net.follow) { net.playing = false; net.cursor = net.tMax; setPlayButton(); setScrub(); } };
    cv.addEventListener('pointermove', (e) => { const r = cv.getBoundingClientRect(); tooltip(e.clientX - r.left, e.clientY - r.top); });
    cv.addEventListener('pointerleave', () => { net.hover = null; $q('nettip').hidden = true; });
    cv.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') stepEvent(1); else if (e.key === 'ArrowLeft') stepEvent(-1);
      else if (e.key === ' ' || e.key === 'Enter') $q('play').click(); else return;
      e.preventDefault();
    });
    if (!net.raf) { net.last = 0; net.raf = requestAnimationFrame(netFrame); }
  }
  let netRz; window.addEventListener('resize', () => { clearTimeout(netRz); netRz = setTimeout(() => { if (net.canvas && net.canvas.isConnected) netSize(); }, 100); });

  function netLegend(g) {
    const teams = [...new Set(g.nodes.map((n) => n.team).filter(Boolean))].sort();
    return `<div class="legend netleg">${teams.map((t) => `<span><i class="tdot" style="background:${teamColor(t)}"></i>${esc(t)}</span>`).join('')}
      ${Object.entries(NET_KINDS).map(([k, v]) => `<span><i class="kdot" style="background:${KIND_COLOR[k]}"></i>${esc(v)} pulse</span>`).join('')}<span>hub = hollow ring; size = recorded activity; lit = active in the last 6 min of timeline</span></div>`;
  }
  function networkView(d) {
    const { g, items } = netData(d);
    if (!g || !Array.isArray(g.nodes) || !g.nodes.length) return empty('No decision network recorded yet.');
    const teams = [...new Set(g.nodes.map((n) => n.team).filter(Boolean))].sort();
    const top = [...g.nodes].sort((a, b) => b.activity - a.activity).slice(0, 12);
    const act = g.active || [];
    const feed = items.slice(-60).reverse().map((e) => `<div><span class="k">${esc(fmtT(Date.parse(e.t)))}</span><span class="k">${esc(e.kind)}</span><span>${esc(e.from)} → ${esc(e.to)}${e.ticket ? ' · ' + esc(e.ticket) : ''}: ${esc(e.text || '')}</span></div>`).join('');
    return `<div class="card"><h2>Decision network</h2>
      <p class="muted">${g.nodes.length} agents and hubs, ${g.edges.length} links, ${items.length} recorded events. ${act.length ? 'Active now: ' + esc(act.map((a) => a.owner + ' (' + a.id + ')').slice(0, 4).join(', ')) : 'No agents running right now.'}</p>
      <fieldset class="netfilters"><legend class="muted">Filters</legend>
        ${Object.entries(NET_KINDS).map(([k, v]) => `<label><input type="checkbox" data-nk="${k}" ${state.net.kinds.includes(k) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}
        <label>Team <select id="netteam" aria-label="Filter network by team"><option value="">All teams</option>${teams.map((t) => `<option ${t === state.net.team ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></fieldset>
      <div class="netwrap" id="netwrap"><canvas id="netcanvas" tabindex="0" role="img" aria-label="Decision network: ${g.nodes.length} agents and hubs. Focus the canvas, then Left and Right arrows step through recorded events and Space plays or pauses the replay."></canvas>
        <div class="nethud"><span id="netclock" class="clock"></span></div><div class="nettip" id="nettip" hidden></div></div>
      <div class="netcontrols">
        <button class="btn" id="play" type="button" aria-pressed="false">Replay</button>
        <input type="range" id="scrub" min="0" max="1000" value="1000" aria-label="Timeline position">
        <label>Speed <select id="speed" aria-label="Replay speed">${[1, 3, 10].map((s) => `<option value="${s}" ${s === net.speed ? 'selected' : ''}>${s}x</option>`).join('')}</select></label>
        <label><input type="checkbox" id="follow" ${net.follow ? 'checked' : ''}> Follow live</label></div>
      ${netLegend(g)}
      <p class="muted">Each pulse is one recorded event travelling along the link it happened on: a hub message, a ticket move, a review verdict or an agent run starting. Replay plays the real event order, time-compressed (the whole history in about 90 s at 1x).</p></div>
      <div class="grid wide"><div class="card"><h2>Event stream</h2><div class="feed">${feed || '<p class="muted">No events.</p>'}</div></div>
      <div class="card"><h2>Most active centers</h2>${table(['Node', 'Kind', 'Team', 'Events'], top.map((n) => [esc(n.id), esc(n.kind), esc(n.team || ''), n.activity]))}</div></div>`;
  }

  function legacyBoard({ snapshot: s }) {
    const all = s.tickets || [];
    if (!all.length) return empty('No tickets yet.');
    const teams = [...new Set(all.map((t) => t.team))];
    const list = all.filter((t) => !state.team || t.team === state.team);
    return `<div class="filters"><label>Team <select id="teamsel"><option value="">All</option>${teams.map((t) => `<option ${t === state.team ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></div>
      <div class="board">${STATUSES.map((st) => {
        const cards = list.filter((t) => t.status === st);
        return `<div class="col"><h3>${esc(st.replace('_', ' '))} (${cards.length})</h3>${cards.map((t) => `<div class="tk ${st === 'blocked' ? 'blocked' : ''}"><b>${esc(t.id)}</b>${esc(t.title)}<div class="m">${esc(t.owner)} · ${esc(t.points)} pt · ${esc(t.team)}${(t.dependsOn || []).length && st !== 'done' ? ' · deps: ' + esc(t.dependsOn.join(', ')) : ''}</div></div>`).join('') || '<p class="muted">-</p>'}</div>`;
      }).join('')}</div>`;
  }

  // ---- views ----
  const views = [
    function overview({ snapshot: s, metrics: m }) {
      const t = m.tickets, c = m.cost;
      const targets = m.targets.length ? table(['Target', 'Actual', 'Target value', 'Status'], m.targets.map((x) => [esc(x.name), fmt(x.actual), fmt(x.target), badge(x.status)])) : empty('No targets configured.');
      return `<div class="grid">${kpi('Tickets', t.total)}${kpi('Done points', `${t.donePoints}/${t.totalPoints}`)}${kpi('WIP', m.wip)}${kpi('Velocity', fmt(m.velocity) + ' pts')}
        ${kpi('Forecast', m.forecast.sprintsRemaining === null ? 'n/a' : m.forecast.sprintsRemaining + ' sprints')}${kpi('Spend', usd(c.totalUsd))}${kpi('Budget left', usd(c.budgetRemainingUsd))}${kpi('Blocked', t.byStatus.blocked || 0, (t.byStatus.blocked || 0) ? 'bad' : '')}</div>
        <div class="card"><h2>Targets${m.currentSprint !== null ? ' (sprint ' + esc(m.currentSprint) + ')' : ''}</h2>${targets}</div>`;
    },
    function org({ snapshot: s }) {
      const teams = (s.teams && s.teams.teams) || [];
      if (!teams.length) return empty('No teams defined (org/teams.json).');
      const inprog = (s.tickets || []).filter((t) => t.status === 'in_progress');
      const head = s.teams.orchestrator ? `<div class="card team"><h2>${esc(s.teams.orchestrator.title || s.teams.orchestrator.id)}</h2><p class="muted">${esc(s.teams.orchestrator.id)} · ${esc(s.teams.orchestrator.model)}</p></div>` : '';
      return head + `<div class="grid wide">${teams.map((t) => {
        const mine = (s.tickets || []).filter((x) => x.team === t.id);
        const active = inprog.filter((x) => x.team === t.id);
        return `<div class="card"><h2>${esc(t.name)}</h2><p class="muted">Director ${esc(t.director && t.director.id)} · Manager ${esc(t.manager && t.manager.id)}</p>
          <h3>Active ICs (${active.length})</h3>${active.length ? `<ul class="plain">${active.map((x) => `<li><b>${esc(x.owner)}</b> on ${esc(x.id)}</li>`).join('')}</ul>` : '<p class="muted">None active</p>'}
          <h3>Assignments (${mine.length})</h3>${mine.length ? `<ul class="plain">${mine.map((x) => `<li>${esc(x.id)} ${badge(x.status)} <span class="muted">${esc(x.owner)}</span></li>`).join('')}</ul>` : '<p class="muted">No tickets</p>'}
          <p class="muted">IC roles: ${esc((t.icRoles || []).join(', '))}</p></div>`;
      }).join('')}</div>`;
    },
    networkView,
    function board(d) {
      const L = d.board;
      if (!L || !Array.isArray(L.tickets)) return legacyBoard(d);
      const sprints = L.sprints || [], teams = [...new Set(L.tickets.map((t) => t.team))].sort();
      if (state.board.sprint === '') state.board.sprint = String(Math.max(0, ...sprints.map((x) => x.number)));
      const f = state.board;
      const rows = L.tickets.filter((t) => (f.sprint === 'all' || String(t.sprint) === f.sprint) && (!f.team || t.team === f.team));
      const COLS = [['backlog|ready', 'Ready'], ['in_progress', 'In progress'], ['review', 'Review'], ['done', 'Done'], ['blocked', 'Blocked']];
      const chips = (t) => [`<span class="chip">${esc(t.points)} pt</span>`, `<span class="chip">${esc(t.tier)}</span>`, t.firstPass === true ? '<span class="chip good">first pass</span>' : '',
        t.rework ? `<span class="chip warn">rework x${esc(t.rework)}</span>` : '', t.defects ? `<span class="chip bad">${esc(t.defects)} escaped defect${t.defects > 1 ? 's' : ''}</span>` : '', t.usd ? `<span class="chip">${usd(t.usd)}</span>` : ''].join('');
      return `<div class="filters"><label>Sprint <select id="bsprint"><option value="all" ${f.sprint === 'all' ? 'selected' : ''}>All sprints</option>${sprints.map((x) => `<option value="${esc(x.number)}" ${String(x.number) === f.sprint ? 'selected' : ''}>${esc(x.name || 'Sprint ' + x.number)}</option>`).join('')}</select></label>
        <label>Team <select id="teamsel"><option value="">All</option>${teams.map((t) => `<option ${t === f.team ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <span class="muted">${rows.length} stories, ${rows.reduce((a, t) => a + (t.points || 0), 0)} points</span></div>
        <div class="board livecols">${COLS.map(([keys, label]) => {
          const cards = rows.filter((t) => keys.split('|').includes(t.status));
          return `<div class="col"><h3>${esc(label)} (${cards.length} · ${cards.reduce((a, t) => a + (t.points || 0), 0)} pt)</h3>${cards.map((t) => `<div class="tk ${t.status === 'blocked' ? 'blocked' : ''}" style="border-left-color:${teamColor(t.team)}"><b>${esc(t.id)}</b>${esc(t.title)}<div class="m">${esc(t.owner || '')} · ${esc(t.team)}</div><div class="chips">${chips(t)}</div></div>`).join('') || '<p class="muted">-</p>'}</div>`;
        }).join('')}</div>`;
    },
    function velocity({ metrics: m }) {
      return `<div class="grid wide"><div class="card"><h2>Committed vs completed</h2>${barChart(m.sprintPoints)}</div>
        <div class="card"><h2>Burndown (remaining points)</h2>${lineChart(m.burndown, 'remaining', m.committed)}</div>
        <div class="card"><h2>Burnup (completed points)</h2>${lineChart(m.burnup, 'completed', m.committed)}</div></div>
        <div class="card"><h2>Forecast</h2><p>${esc(m.forecast.text)}</p><p class="muted">Rolling average velocity: ${fmt(m.velocity)} points per sprint.</p></div>`;
    },
    function quality({ metrics: m }) {
      const q = m.quality;
      return `<div class="grid">${kpi('Tests passed', q.testsTotal === null ? 'n/a' : `${q.testsPassed}/${q.testsTotal}`)}${kpi('Test pass rate', pct(q.testPassRate))}${kpi('Coverage', q.coveragePct === null ? 'n/a' : fmt(q.coveragePct) + '%')}
        ${kpi('Build', q.buildGreen === null ? 'n/a' : q.buildGreen ? 'green' : 'red', q.buildGreen === null ? '' : q.buildGreen ? 'good' : 'bad')}${kpi('Defect escape', pct(q.defectEscapeRate))}${kpi('Rework rate', pct(q.rework ?? q.reworkRate))}${kpi('First-pass', pct(q.firstPassAcceptance))}</div>
        <p class="muted">${q.at ? 'Test results from ' + esc(q.at) : 'No org/quality.json yet. Run node dashboard/quality-report.mjs.'}</p>`;
    },
    function flow({ metrics: m }) {
      const rows = Object.entries(m.flow.perTeam).map(([t, v]) => [esc(t), fmt(v.cycleHours), fmt(v.leadHours), v.samples]);
      const sd = m.serialDependencies;
      return `<div class="grid">${kpi('WIP', m.wip)}${kpi('Avg cycle (h)', fmt(m.flow.cycleHours))}${kpi('Avg lead (h)', fmt(m.flow.leadHours))}${kpi('Synapse latency (min)', fmt(m.synapse.avgMinutes))}${kpi('Unanswered requests', m.synapse.unanswered)}${kpi('Serial deps open', sd.count, sd.count ? 'warn' : '')}</div>
        <div class="card"><h2>Cycle and lead time per team</h2>${table(['Team', 'Cycle (h)', 'Lead (h)', 'Done tickets'], rows)}</div>
        ${sd.count ? `<p class="muted">Blocked by dependencies: ${esc(sd.ids.join(', '))}</p>` : ''}`;
    },
    function cost({ metrics: m }) {
      const c = m.cost;
      return `<div class="grid">${kpi('Total spend', usd(c.totalUsd))}${kpi('Budget', usd(c.budgetUsd))}${kpi('Remaining', usd(c.budgetRemainingUsd))}${kpi('Used', c.budgetUsedPct === null ? 'n/a' : c.budgetUsedPct + '%')}${kpi('Points per $', fmt(c.pointsPerDollar))}</div>
        <div class="grid wide"><div class="card"><h2>By team</h2>${hbars(c.byTeam, usd)}</div><div class="card"><h2>By sprint</h2>${hbars(c.bySprint, usd)}</div><div class="card"><h2>By ticket</h2>${hbars(c.byTicket, usd)}</div>
        <div class="card"><h2>Model tier mix</h2>${tierMix(m.tierMix)}</div></div>`;
    },
    function performance({ metrics: m }) {
      const sc = m.scorecards || { agents: [], teams: [] };
      if (!(sc.agents || []).length && !(sc.teams || []).length) return empty('No scorecards yet (org/scorecards/latest.json).');
      const row = (r) => [esc(r.key || r.id || r.agent || r.team || r.name), fmt(r.composite), r.tickets ?? r.ticketCount ?? r.ticketsDone ?? 'n/a',
        (r.lowPerformerFlag ? '<span class="badge off-track">low performer</span>' : '') + (r.lowConfidence ? ' <span class="badge">low confidence</span>' : '') || '-', esc((r.diagnosis || []).join('; '))];
      return `<div class="grid wide"><div class="card"><h2>Agents</h2>${table(['Agent', 'Composite', 'Tickets', 'Flags', 'Diagnosis'], (sc.agents || []).map(row))}</div>
        <div class="card"><h2>Teams</h2>${table(['Team', 'Composite', 'Tickets', 'Flags', 'Diagnosis'], (sc.teams || []).map(row))}</div></div>
        <p class="muted">Fewer than 3 tickets means low confidence; no action is taken on those rows.</p>`;
    },
    function agentRank(d) {
      const items = d.rank && d.rank.items;
      if (!items || !items.length) return empty('No agent rank yet (org/live/rank.json).');
      const p = (v) => (v == null ? '-' : Math.round(v * 100) + '%');
      const cls = { deprecated: 'off-track', 'on watch': 'at-risk', active: 'on-track' };
      return `<div class="card"><h2>Agent stack rank</h2><p class="muted">Agent configurations ranked by composite score (first-pass acceptance 35%, no rework 20%, estimate accuracy 20%, cost efficiency 15%, no escaped defects 10%). Policy (ADR-004): fewer than 3 tickets is low confidence and never acted on.</p>
        ${table(['#', 'Agent', 'Team', 'Tickets', 'Points', 'First pass', 'Rework', 'Defects', '$ / point', 'Composite', 'Status', 'Diagnosis / action'], items.map((a) => [a.rank, esc(a.key), esc(a.team || ''), a.tickets, a.points, p(a.firstPassAcceptance), p(a.reworkRate), fmt(Number(a.defects || 0), 1), a.costPerPoint == null ? '-' : usd(a.costPerPoint), fmt(a.composite),
          `<span class="badge ${cls[a.status] || ''}">${esc(a.status)}${a.lowConfidence ? ' · low conf.' : ''}</span>`,
          esc(a.deprecation ? 'Deprecated: ' + (a.deprecation.reason || '') : a.intervention ? a.intervention : a.lowConfidence ? 'Low confidence (<3 tickets): no action' : (a.diagnosis || []).join('; '))]))}</div>`;
    },
    function sprintReview({ metrics: m }) {
      const rs = m.sprintReviews || [];
      if (!rs.length) return empty('No sprints yet.');
      return rs.map((s) => {
        const r = s.review;
        const kp = r ? `<div class="grid">${kpi('Points', `${fmt(r.completedPoints)}/${fmt(r.committedPoints)}`)}${kpi('Spend', usd(r.usd))}${kpi('Points per $', fmt(r.pointsPerDollar))}${kpi('First-pass', pct(r.firstPassAcceptance))}${kpi('Rework', pct(r.reworkRate))}${kpi('Tests', r.testsPassed ?? pct(r.testPassRate))}</div>
          ${list(r.shipped).replace('<ul>', '<h3>Shipped</h3><ul>')}` : '<p class="muted">Review not written yet.</p>';
        const t = s.retro;
        const retro = t ? `<div class="grid wide"><div><h3>Went well</h3>${list(t.went_well)}</div><div><h3>Went badly</h3>${list(t.went_badly)}</div><div><h3>Manager retros</h3>${list(t.manager_retros)}</div></div>` : '<p class="muted">No retro yet.</p>';
        return `<div class="card"><h2>${esc(s.name)} ${badge(s.status)}</h2>${s.goal ? `<p class="muted">${esc(s.goal)}</p>` : ''}${kp}${retro}</div>`;
      }).join('');
    },
    function valueDrivers({ metrics: m }) {
      const vd = m.valueDrivers || [];
      if (!vd.length) return empty('No value drivers found (product/value-propositions.md).');
      return `<div class="grid wide">${vd.map((d) => `<div class="card"><h2>${esc(d.id)}</h2><p>${esc(d.title)}</p>
        <p class="muted">${d.tickets.length} ticket(s) · ${d.donePoints}/${d.points} pts done</p>
        ${d.tickets.length ? `<ul class="plain">${d.tickets.map((t) => `<li><b>${esc(t.id)}</b> ${badge(t.status)} <span class="muted">${esc(t.title)}</span></li>`).join('')}</ul>` : '<p class="muted">No linked tickets yet.</p>'}</div>`).join('')}</div>`;
    },
    function improvements({ metrics: m, snapshot: s }) {
      const l = m.improvements || (Array.isArray(s.improvements) ? s.improvements : []);
      return `<div class="card"><h2>Improvement log</h2>${table(['Hypothesis', 'Owner', 'Metric', 'Before', 'After', 'Target', 'Result'],
        l.map((i) => [esc(i.hypothesis), esc(i.owner), esc(i.metric), fmt(i.before), fmt(i.after), fmt(i.target), esc(i.result ?? i.status)]))}</div>`;
    },
  ];

  // ---- header: where the data came from and how old it is ----
  const SOURCE_LABEL = { db: 'live', local: 'local', snapshot: 'snapshot' };
  function ageText(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    return h < 48 ? h + ' h ago' : Math.floor(h / 24) + ' d ago';
  }
  function renderPill() {
    const el = $('live'); if (!el) return;
    const age = state.at ? Date.now() - state.at : null;
    const amber = age !== null && age > 30 * 60000;
    el.textContent = state.error && !state.data ? 'stale' : SOURCE_LABEL[state.source] + (age === null ? '' : ' · updated ' + ageText(age));
    el.className = 'pill src-' + state.source + (amber ? ' amber' : '') + (state.error && state.source === 'local' ? ' stale' : '');
    el.title = state.at ? 'Data generated ' + new Date(state.at).toLocaleString() : '';
  }

  function render() {
    $('tabs').innerHTML = TABS.map((t, i) => `<button role="tab" aria-selected="${i === state.tab}" tabindex="${i === state.tab ? 0 : -1}" data-i="${i}">${esc(t)}</button>`).join('');
    const d = state.data;
    if (!d) { $('view').innerHTML = empty(state.error ? 'Cannot load data: ' + state.error : 'Loading…'); renderPill(); return; }
    $('program').textContent = (d.snapshot.config && d.snapshot.config.program) || 'Program Dashboard';
    $('meta').textContent = 'Generated ' + (d.snapshot.generatedAt || 'n/a');
    renderPill();
    try { $('view').innerHTML = views[state.tab](d); } catch (e) { $('view').innerHTML = empty('Render error: ' + e.message); }
    document.querySelectorAll('[data-nk]').forEach((c) => { c.onchange = () => { state.net.kinds = [...document.querySelectorAll('[data-nk]')].filter((x) => x.checked).map((x) => x.dataset.nk); }; });
    const nt = $('netteam'); if (nt) nt.onchange = () => { state.net.team = nt.value; };
    const sel = $('teamsel'); if (sel) sel.onchange = () => { if ($('bsprint')) state.board.team = sel.value; else state.team = sel.value; render(); };
    const bs = $('bsprint'); if (bs) bs.onchange = () => { state.board.sprint = bs.value; render(); };
    if (TABS[state.tab] === 'Decision network' && $('netcanvas')) mountNet(d);
  }

  // ---- data layer: embedded snapshot, then the artifact database, else the local server, else stay on the snapshot ----
  const LIVE_NAMES = ['board', 'rank', 'graph', 'events', 'metrics'];
  const docTime = (doc) => (doc && doc.generatedAt ? Date.parse(doc.generatedAt) : NaN);
  /** Re-render from the five live documents (board, rank, graph, events and, when present, metrics). */
  function applyLive(parts, source) {
    if (!(parts.board && parts.rank && parts.graph && parts.events) || !state.data) return;
    const sig = JSON.stringify(parts, (k, v) => (k === 'generatedAt' ? undefined : v));
    const times = LIVE_NAMES.map((n) => docTime(parts[n])).filter((t) => !Number.isNaN(t));
    state.at = times.length ? Math.max(...times) : state.at;
    state.source = source; state.error = null;
    if (sig === state.sig) { renderPill(); return; }
    state.sig = sig;
    const snap = state.base.snapshot;
    state.data = {
      snapshot: { ...snap, tickets: parts.board.tickets.map((t) => ({ ...(snap.tickets || []).find((x) => x.id === t.id), ...t })), graph: parts.graph },
      metrics: parts.metrics || state.base.metrics, graph: parts.graph, board: parts.board, rank: parts.rank, events: parts.events,
    };
    const ae = document.activeElement;
    const editing = TABS[state.tab] !== 'Decision network' && ae && $('view').contains(ae) && /^(SELECT|INPUT)$/.test(ae.tagName);
    if (!editing) render();
  }
  function useEmbedded(snap) {
    state.base = snap; state.data = snap; state.source = 'snapshot'; state.at = Date.parse(snap.snapshot.generatedAt) || null;
    if (snap.live && snap.live.board) {
      const L = snap.live, times = ['board', 'metrics'].map((n) => docTime(L[n])).filter((t) => !Number.isNaN(t));
      state.data = { ...snap, board: L.board, rank: L.rank, events: L.events, metrics: L.metrics || snap.metrics };
      if (times.length) state.at = Math.max(...times);
    }
    render();
  }
  async function fetchJson(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); }
  async function startLive() {
    // Never subscribe inside render: this runs once, after the first paint.
    let db = null;
    try { db = (window.claude && window.claude.use) ? await window.claude.use('db') : null; } catch { db = null; }
    if (db) {
      const parts = {};
      db.collection('live').onSnapshot((qs) => {
        for (const d of qs.docs) if (d.exists) parts[d.id] = typeof d.data === 'function' ? d.data() : d.data;
        applyLive(parts, 'db');
      }, () => {});
      return;
    }
    if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return; // opened as a file: stay on the snapshot, make no requests
    const poll = async () => {
      try {
        const got = await Promise.all(LIVE_NAMES.map((n) => fetchJson('/api/live/' + n)));
        applyLive(Object.fromEntries(LIVE_NAMES.map((n, i) => [n, got[i]])), 'local');
      } catch (e) { state.error = e.message; renderPill(); }
      setTimeout(poll, 5000);
    };
    poll();
  }
  async function load() {
    if (window.__SNAPSHOT__) { useEmbedded(window.__SNAPSHOT__); startLive(); return; }
    try {
      const [snapshot, metrics] = await Promise.all(['/api/snapshot', '/api/metrics'].map(fetchJson));
      useEmbedded({ snapshot, metrics, graph: snapshot.graph });
    } catch (e) { state.error = e.message; render(); return; }
    startLive();
  }

  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.tab = Number(b.dataset.i); render(); } });
  $('tabs').addEventListener('keydown', (e) => {
    const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!k) return;
    state.tab = (state.tab + k + TABS.length) % TABS.length; render(); const b = $('tabs').querySelector('[aria-selected=true]'); if (b) b.focus(); e.preventDefault();
  });
  setInterval(renderPill, 30000); // keeps "updated 2 min ago" honest between data updates
  render();
  load();
})();
