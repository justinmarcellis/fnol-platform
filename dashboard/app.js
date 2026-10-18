// PMO dashboard UI. Data comes from /api/snapshot + /api/metrics, or window.__SNAPSHOT__ in the exported file.
(function () {
  const TABS = ['Overview', 'Org chart', 'Sprint board', 'Velocity & forecast', 'Quality', 'Flow', 'Cost', 'Performance', 'Improvement log'];
  const STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done', 'blocked'];
  const state = { tab: 0, team: '', data: null, error: null };
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
    function board({ snapshot: s }) {
      const all = s.tickets || [];
      if (!all.length) return empty('No tickets yet.');
      const teams = [...new Set(all.map((t) => t.team))];
      const list = all.filter((t) => !state.team || t.team === state.team);
      return `<div class="filters"><label>Team <select id="teamsel"><option value="">All</option>${teams.map((t) => `<option ${t === state.team ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></div>
        <div class="board">${STATUSES.map((st) => {
          const cards = list.filter((t) => t.status === st);
          return `<div class="col"><h3>${esc(st.replace('_', ' '))} (${cards.length})</h3>${cards.map((t) => `<div class="tk ${st === 'blocked' ? 'blocked' : ''}"><b>${esc(t.id)}</b>${esc(t.title)}<div class="m">${esc(t.owner)} · ${esc(t.points)} pt · ${esc(t.team)}${(t.dependsOn || []).length && st !== 'done' ? ' · deps: ' + esc(t.dependsOn.join(', ')) : ''}</div></div>`).join('') || '<p class="muted">-</p>'}</div>`;
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
        <div class="grid wide"><div class="card"><h2>By team</h2>${hbars(c.byTeam, usd)}</div><div class="card"><h2>By sprint</h2>${hbars(c.bySprint, usd)}</div><div class="card"><h2>By ticket</h2>${hbars(c.byTicket, usd)}</div></div>`;
    },
    function performance({ metrics: m }) {
      const sc = m.scorecards || { agents: [], teams: [] };
      const row = (r) => [esc(r.id || r.agent || r.team || r.name), fmt(r.composite), r.tickets ?? r.ticketCount ?? 'n/a',
        (r.lowPerformerFlag ? '<span class="badge off-track">low performer</span>' : '') + (r.lowConfidence ? ' <span class="badge">low confidence</span>' : '') || '-'];
      return `<div class="grid wide"><div class="card"><h2>Agents</h2>${table(['Agent', 'Composite', 'Tickets', 'Flags'], (sc.agents || []).map(row))}</div>
        <div class="card"><h2>Teams</h2>${table(['Team', 'Composite', 'Tickets', 'Flags'], (sc.teams || []).map(row))}</div></div>
        <p class="muted">Fewer than 3 tickets means low confidence; no action is taken on those rows.</p>`;
    },
    function improvements({ snapshot: s }) {
      const l = Array.isArray(s.improvements) ? s.improvements : [];
      return `<div class="card"><h2>Improvement log</h2>${table(['Hypothesis', 'Owner', 'Metric', 'Before', 'After', 'Result'],
        l.map((i) => [esc(i.hypothesis), esc(i.owner), esc(i.metric), fmt(i.before), fmt(i.after), esc(i.result)]))}</div>`;
    },
  ];

  function render() {
    $('tabs').innerHTML = TABS.map((t, i) => `<button role="tab" aria-selected="${i === state.tab}" data-i="${i}">${esc(t)}</button>`).join('');
    const d = state.data;
    if (!d) { $('view').innerHTML = empty(state.error ? 'Cannot load data: ' + state.error : 'Loading…'); return; }
    $('program').textContent = (d.snapshot.config && d.snapshot.config.program) || 'Program Dashboard';
    $('meta').textContent = 'Generated ' + (d.snapshot.generatedAt || 'n/a');
    $('live').textContent = state.error ? 'stale' : window.__SNAPSHOT__ ? 'snapshot' : 'live';
    $('live').className = 'pill' + (state.error ? ' stale' : '');
    try { $('view').innerHTML = views[state.tab](d); } catch (e) { $('view').innerHTML = empty('Render error: ' + e.message); }
    const sel = $('teamsel'); if (sel) sel.onchange = () => { state.team = sel.value; render(); };
  }

  async function load() {
    if (window.__SNAPSHOT__) { state.data = window.__SNAPSHOT__; render(); return; }
    try {
      const [snapshot, metrics] = await Promise.all(['/api/snapshot', '/api/metrics'].map((u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); })));
      state.data = { snapshot, metrics }; state.error = null;
    } catch (e) { state.error = e.message; }
    render();
  }

  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.tab = Number(b.dataset.i); render(); } });
  render();
  load();
  if (!window.__SNAPSHOT__) setInterval(load, 10000);
})();
