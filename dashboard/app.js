// PMO dashboard UI. Data comes from /api/snapshot + /api/metrics, or window.__SNAPSHOT__ in the exported file.
(function () {
  const TABS = ['Overview', 'Org chart', 'Decision network', 'Sprint board', 'Velocity & forecast', 'Quality', 'Flow', 'Cost', 'Performance', 'Sprint review', 'Value drivers', 'Improvement log'];
  const STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done', 'blocked'];
  const state = { tab: 0, team: '', data: null, error: null, net: { kinds: ['msg', 'ticket', 'review', 'run'], team: '' } };
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


  // ---- decision network (inline SVG, deterministic layout, no dependencies) ----
  const NET_KINDS = { msg: 'message', ticket: 'ticket move', review: 'review verdict', run: 'agent run' };
  const netCache = { key: null, pos: null };
  const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };
  const teamHue = (t) => Math.round(hash('team:' + (t || 'none')) * 360);
  function layoutNet(g, W, H) {
    const key = g.nodes.length + ':' + g.edges.length + ':' + W + ':' + (g.nodes[0] && g.nodes[0].activity);
    if (netCache.key === key) return netCache.pos;
    const teams = [...new Set(g.nodes.map((n) => n.team).filter(Boolean))].sort();
    const ang = (t) => (Math.max(0, teams.indexOf(t)) / Math.max(teams.length, 1)) * Math.PI * 2;
    const N = g.nodes.map((n) => {
      const a = ang(n.team) + (hash(n.id) - .5) * .6, rad = n.kind === 'orchestrator' ? 0 : (n.kind === 'hub' ? .2 : .36) * Math.min(W, H);
      return { id: n.id, kind: n.kind, team: n.team, x: W / 2 + Math.cos(a) * rad, y: H / 2 + Math.sin(a) * rad, vx: 0, vy: 0, r: nodeR(n) };
    });
    const idx = new Map(N.map((n, i) => [n.id, i]));
    const L = g.edges.filter((e) => idx.has(e.source) && idx.has(e.target)).map((e) => [idx.get(e.source), idx.get(e.target), e.count]);
    for (let it = 0; it < 320; it++) {
      const cool = 1 - it / 320;
      for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
        let dx = N[j].x - N[i].x, dy = N[j].y - N[i].y, d2 = dx * dx + dy * dy || 1; const d = Math.sqrt(d2);
        const f = ((N[i].kind === 'hub' || N[j].kind === 'hub' ? 14000 : 7000) / d2) * cool; const min = N[i].r + N[j].r + 4;
        const push = f + (d < min ? (min - d) * .4 : 0);
        dx /= d; dy /= d; N[i].vx -= dx * push; N[i].vy -= dy * push; N[j].vx += dx * push; N[j].vy += dy * push;
      }
      for (const [a, b, c] of L) {
        const dx = N[b].x - N[a].x, dy = N[b].y - N[a].y, d = Math.sqrt(dx * dx + dy * dy) || 1, want = 70 + 90 / Math.sqrt(c);
        const f = (d - want) * Math.min(.05, .004 + c / 800);
        N[a].vx += (dx / d) * f; N[a].vy += (dy / d) * f; N[b].vx -= (dx / d) * f; N[b].vy -= (dy / d) * f;
      }
      for (const n of N) {
        const tx = n.kind === 'orchestrator' ? W / 2 : W / 2 + Math.cos(ang(n.team)) * W * .28, ty = n.kind === 'orchestrator' ? H / 2 : H / 2 + Math.sin(ang(n.team)) * H * .3;
        n.vx += (tx - n.x) * .008; n.vy += (ty - n.y) * .008;
        n.x += Math.max(-12, Math.min(12, n.vx)); n.y += Math.max(-12, Math.min(12, n.vy)); n.vx *= .6; n.vy *= .6;
        n.x = Math.max(n.r + 6, Math.min(W - n.r - 6, n.x)); n.y = Math.max(n.r + 14, Math.min(H - n.r - 14, n.y));
      }
    }
    netCache.key = key; netCache.pos = new Map(N.map((n) => [n.id, n]));
    return netCache.pos;
  }
  function nodeR(n) { return 3 + Math.sqrt(n.activity || 0) * (n.kind === 'hub' ? 1.6 : 1.1); }
  function netChart(g) {
    const narrow = window.innerWidth < 640, W = narrow ? 390 : 1000, H = narrow ? 600 : 520;
    const pos = layoutNet(g, W, H), kinds = new Set(state.net.kinds), team = state.net.team;
    const inTeam = (n) => !team || n.team === team;
    const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
    const edges = g.edges.map((e) => {
      const ks = Object.entries(e.kinds || {}).filter(([k]) => kinds.has(k));
      return { e, ks, n: ks.reduce((a, [, v]) => a + v, 0) };
    }).filter((x) => x.n > 0 && pos.has(x.e.source) && pos.has(x.e.target) && (inTeam(nodeById.get(x.e.source)) || inTeam(nodeById.get(x.e.target))));
    const shown = new Set(); edges.forEach((x) => { shown.add(x.e.source); shown.add(x.e.target); });
    const lines = edges.map(({ e, ks, n }) => {
      const a = pos.get(e.source), b = pos.get(e.target), dom = ks.sort((p, q) => q[1] - p[1])[0][0];
      return `<line class="ne k-${esc(dom)}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke-width="${Math.min(4, .6 + Math.log2(1 + n) * .5).toFixed(2)}"><title>${esc(e.source)} to ${esc(e.target)}: ${ks.map(([k, v]) => v + ' ' + (NET_KINDS[k] || k)).join(', ')}</title></line>`;
    }).join('');
    const nodes = g.nodes.filter((n) => shown.has(n.id) && pos.has(n.id)).map((n) => {
      const p = pos.get(n.id), dim = !inTeam(n);
      const lab = n.kind === 'hub' || n.kind === 'orchestrator' || n.activity > 70
        ? `<text class="nl" x="${p.x.toFixed(1)}" y="${(p.y - p.r - 4).toFixed(1)}" text-anchor="middle">${esc(n.id.replace('hub:', '#'))}</text>` : '';
      return `<g class="nn ${n.kind === 'hub' ? 'hubn' : ''}${dim ? ' dim' : ''}" style="--h:${teamHue(n.team)}"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.r.toFixed(1)}"><title>${esc(n.id)} (${esc(n.kind)}${n.team ? ', ' + esc(n.team) : ''}): ${n.activity} events</title></circle>${lab}</g>`;
    }).join('');
    return `<svg class="netsvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Decision network: ${shown.size} agents and hubs connected by ${edges.length} recorded message, ticket, review and agent-run links">${lines}${nodes}</svg>`;
  }
  function netLegend(g) {
    const teams = [...new Set(g.nodes.map((n) => n.team).filter(Boolean))].sort();
    return `<div class="legend netleg">${teams.map((t) => `<span><i class="tdot" style="--h:${teamHue(t)}"></i>${esc(t)}</span>`).join('')}
      ${Object.entries(NET_KINDS).map(([k, v]) => `<span><i class="kdot k-${k}"></i>${esc(v)}</span>`).join('')}<span>hub = hollow ring; size = recorded activity</span></div>`;
  }
  function networkView(d) {
    const g = d.graph || (d.snapshot && d.snapshot.graph);
    if (!g || !Array.isArray(g.nodes) || !g.nodes.length) return empty('No decision network recorded yet.');
    const teams = [...new Set(g.nodes.map((n) => n.team).filter(Boolean))].sort();
    const top = [...g.nodes].sort((a, b) => b.activity - a.activity).slice(0, 12);
    const act = g.active || [];
    return `<div class="card"><h2>Decision network</h2>
      <p class="muted">${g.nodes.length} agents and hubs, ${g.edges.length} links. Each link is recorded hub messages, ticket moves (assignments), review verdicts or agent runs. ${act.length ? 'Active now: ' + esc(act.map((a) => a.owner + ' (' + a.id + ')').slice(0, 4).join(', ')) : 'No agents running right now.'}</p>
      <fieldset class="netfilters"><legend class="muted">Filters</legend>
        ${Object.entries(NET_KINDS).map(([k, v]) => `<label><input type="checkbox" data-nk="${k}" ${state.net.kinds.includes(k) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}
        <label>Team <select id="netteam" aria-label="Filter network by team"><option value="">All teams</option>${teams.map((t) => `<option ${t === state.net.team ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></fieldset>
      <div class="netwrap" id="netwrap">${netChart(g)}</div>${netLegend(g)}</div>
      <div class="card"><h2>Most active centers</h2>${table(['Node', 'Kind', 'Team', 'Events'], top.map((n) => [esc(n.id), esc(n.kind), esc(n.team || ''), n.activity]))}</div>`;
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

  function render() {
    $('tabs').innerHTML = TABS.map((t, i) => `<button role="tab" aria-selected="${i === state.tab}" tabindex="${i === state.tab ? 0 : -1}" data-i="${i}">${esc(t)}</button>`).join('');
    const d = state.data;
    if (!d) { $('view').innerHTML = empty(state.error ? 'Cannot load data: ' + state.error : 'Loading…'); return; }
    $('program').textContent = (d.snapshot.config && d.snapshot.config.program) || 'Program Dashboard';
    $('meta').textContent = 'Generated ' + (d.snapshot.generatedAt || 'n/a');
    $('live').textContent = state.error ? 'stale' : window.__SNAPSHOT__ ? 'snapshot' : 'live';
    $('live').className = 'pill' + (state.error ? ' stale' : '');
    try { $('view').innerHTML = views[state.tab](d); } catch (e) { $('view').innerHTML = empty('Render error: ' + e.message); }
    document.querySelectorAll('[data-nk]').forEach((c) => { c.onchange = () => { state.net.kinds = [...document.querySelectorAll('[data-nk]')].filter((x) => x.checked).map((x) => x.dataset.nk); const g = d.graph || d.snapshot.graph; $('netwrap').innerHTML = netChart(g); }; });
    const nt = $('netteam'); if (nt) nt.onchange = () => { state.net.team = nt.value; $('netwrap').innerHTML = netChart(d.graph || d.snapshot.graph); };
    const sel = $('teamsel'); if (sel) sel.onchange = () => { state.team = sel.value; render(); };
  }

  async function load() {
    if (window.__SNAPSHOT__) { state.data = window.__SNAPSHOT__; render(); return; }
    try {
      const [snapshot, metrics] = await Promise.all(['/api/snapshot', '/api/metrics'].map((u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); })));
      state.data = { snapshot, metrics, graph: snapshot.graph }; state.error = null;
    } catch (e) { state.error = e.message; }
    render();
  }

  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.tab = Number(b.dataset.i); render(); } });
  $('tabs').addEventListener('keydown', (e) => {
    const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!k) return;
    state.tab = (state.tab + k + TABS.length) % TABS.length; render(); const b = $('tabs').querySelector('[aria-selected=true]'); if (b) b.focus(); e.preventDefault();
  });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (TABS[state.tab] === 'Decision network' && state.data) render(); }, 150); });
  render();
  load();
  if (!window.__SNAPSHOT__) setInterval(load, 10000);
})();
