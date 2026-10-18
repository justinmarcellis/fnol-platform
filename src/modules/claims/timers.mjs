// Regulatory timers: start from tenant config, stop on events, tick from the clock.
// Timer definitions are TenantConfig.timers[]; the seeded WI/IL/MI values are illustrative.

const DAY = 86400000;
const HOUR = 3600000;
const SYSTEM = { type: 'system', id: 'claims-timers', role: 'system' };

const isoDate = (d) => d.toISOString().slice(0, 10);

/** Add n (may be negative) business days to a Date, skipping Saturdays, Sundays and holidays (UTC dates). */
export function addBusinessDays(date, n, holidays = []) {
  const skip = new Set(holidays);
  const d = new Date(date.getTime());
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    d.setTime(d.getTime() + step * DAY);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !skip.has(isoDate(d))) left--;
  }
  return d;
}

/**
 * Date + (sign * duration). Units: hours, days (24h), business_days.
 * @param {Date} date
 * @param {{ value: number, unit: string }} dur
 * @param {1|-1} [sign]
 * @param {string[]} [holidays]
 */
export function addDuration(date, dur, sign = 1, holidays = []) {
  const v = sign * dur.value;
  if (dur.unit === 'hours') return new Date(date.getTime() + v * HOUR);
  if (dur.unit === 'business_days') return addBusinessDays(date, v, holidays);
  return new Date(date.getTime() + v * DAY);
}

const toDate = (v) => (v instanceof Date ? v : new Date(v));

/** Row -> RegulatoryTimer domain shape. */
export function timerFromRow(r) {
  const doc = JSON.parse(r.doc);
  return {
    id: r.id, tenantId: r.tenant_id, claimId: r.claim_id, state: r.state, kind: r.kind, definitionId: r.definition_id,
    startedAt: r.started_at, ...(r.warn_at ? { warnAt: r.warn_at } : {}), dueAt: r.due_at, status: r.status,
    ...(r.met_at ? { metAt: r.met_at } : {}), ...(r.breached_at ? { breachedAt: r.breached_at } : {}),
    ...(doc.citation ? { citation: doc.citation } : {}),
  };
}

/**
 * @param {object} ctx tenant-bound ctx
 * @param {{ loadClaim: Function, addFlag: Function, addTask: Function, setQueue: Function, touch: Function }} hooks
 *   callbacks into the claims service (kept as hooks so timers.mjs has no import cycle)
 */
export function createTimers(ctx, hooks) {
  const db = ctx.db;
  const cfg = () => ctx.tenant.config ?? {};
  const row = (id) => db.get('SELECT * FROM regulatory_timers WHERE id = ?', id);

  function list(claimId) {
    return db.all('SELECT * FROM regulatory_timers WHERE claim_id = ? ORDER BY due_at, id', claimId).map(timerFromRow);
  }

  /** Create the timers whose startOn is `eventType` and which match the claim's risk state and LOB. Idempotent. */
  function start(claim, eventType, startedAt = ctx.clock.now(), { quiet = false } = {}) {
    const config = cfg();
    const holidays = config.holidays ?? [];
    const created = [];
    for (const def of config.timers ?? []) {
      if ((def.startOn ?? 'claim.reported') !== eventType) continue;
      if (!claim.riskState || def.state !== claim.riskState) continue;
      if (def.lobs?.length && !def.lobs.includes(claim.lob)) continue;
      if (db.get('SELECT 1 AS x FROM regulatory_timers WHERE claim_id = ? AND definition_id = ?', claim.id, def.id)) continue;
      const started = toDate(startedAt);
      const due = addDuration(started, def.duration, 1, holidays);
      const warn = def.warnBefore ? addDuration(due, def.warnBefore, -1, holidays) : null;
      const id = db.id('tmr');
      db.insert('regulatory_timers', {
        id, claim_id: claim.id, definition_id: def.id, state: def.state, kind: def.kind,
        started_at: started.toISOString(), warn_at: warn && warn > started ? warn.toISOString() : null,
        due_at: due.toISOString(), status: 'running', doc: { citation: def.citation ?? null },
      });
      ctx.audit.record({
        actor: 'system:claims-timers', action: 'claim.timer.started', entityType: 'claim', entityId: claim.id,
        details: { timerId: id, definitionId: def.id, kind: def.kind, dueAt: due.toISOString() },
      });
      if (!quiet) hooks.touch(claim.id, 'timer_started', { timerId: id, definitionId: def.id });
      created.push(timerFromRow(row(id)));
    }
    return created;
  }

  function finish(r, status, change) {
    const now = ctx.clock.nowIso();
    db.transaction(() => {
      db.update('regulatory_timers', r.id, { status, ...(status === 'met' ? { met_at: now } : {}) });
      ctx.audit.record({
        actor: 'system:claims-timers', action: `claim.timer.${status}`, entityType: 'claim', entityId: r.claim_id,
        details: { timerId: r.id, definitionId: r.definition_id },
      });
      hooks.touch(r.claim_id, change, { timerId: r.id, definitionId: r.definition_id });
    });
  }

  const open = (claimId) => db.all("SELECT * FROM regulatory_timers WHERE claim_id = ? AND status IN ('running','due_soon','paused')", claimId);
  const def = (id) => (cfg().timers ?? []).find((d) => d.id === id);

  /** claim.status.changed: meet timers whose stopOn matches, cancel everything when the claim ends. */
  function onStatusChanged(claimId, to) {
    for (const r of open(claimId)) {
      const stop = def(r.definition_id)?.stopOn;
      if (stop?.event === 'claim.status.changed' && stop.toStatus?.includes(to)) finish(r, 'met', 'timer_met');
      else if (to === 'closed' || to === 'withdrawn') finish(r, 'cancelled', 'timer_cancelled');
    }
  }

  /** A completed task meets timers whose stopOn.taskType matches the task type. */
  function onTaskCompleted(claimId, taskType) {
    for (const r of open(claimId)) {
      if (taskType && def(r.definition_id)?.stopOn?.taskType === taskType) finish(r, 'met', 'timer_met');
    }
  }

  /** Any other event named by a stopOn.event (without toStatus/taskType filters, or with a matching toStatus). */
  function onEvent(evt) {
    const claimId = evt.data?.claimId;
    if (!claimId || evt.type === 'claim.status.changed') return;
    for (const r of open(claimId)) {
      const stop = def(r.definition_id)?.stopOn;
      if (stop?.event === evt.type && !stop.taskType && (!stop.toStatus || stop.toStatus.includes(evt.data.to))) finish(r, 'met', 'timer_met');
    }
  }

  /** Start timers whose startOn is this event (other than claim.reported, which createClaim handles). */
  function onStartEvent(evt) {
    const claimId = evt.data?.claimId;
    if (!claimId || !(cfg().timers ?? []).some((d) => (d.startOn ?? 'claim.reported') === evt.type)) return [];
    const claim = hooks.loadClaim(claimId);
    return claim ? start(claim, evt.type, evt.time ?? ctx.clock.now()) : [];
  }

  function applyBreach(r, claimId) {
    const actions = def(r.definition_id)?.onBreach ?? [];
    const applied = [];
    for (const a of actions) {
      try {
        if (a.type === 'add_flag' && a.flag) hooks.addFlag(claimId, a.flag, SYSTEM);
        else if (a.type === 'add_task' && a.task) {
          hooks.addTask(claimId, {
            type: a.task.type, title: a.task.title ?? 'Resolve breached deadline', queue: a.task.queue, priority: 'high',
            ...(a.task.dueInHours ? { dueAt: new Date(ctx.clock.now().getTime() + a.task.dueInHours * HOUR).toISOString() } : {}),
            timerId: r.id,
          }, SYSTEM);
        } else if ((a.type === 'route_queue' && a.queue) || (a.type === 'assign_adjuster' && a.adjusterId)) {
          hooks.setQueue(claimId, a.type === 'route_queue' ? { queue: a.queue } : { adjusterId: a.adjusterId }, SYSTEM);
        } else continue; // notify and the rest are handled by other modules reacting to claim.timer.breached
        applied.push(a.type);
      } catch (e) {
        ctx.log.warn('timer breach action failed', { timerId: r.id, action: a.type, error: e.message });
      }
    }
    return applied;
  }

  /**
   * Tick for this tenant: publish claim.timer.due once at warnAt and claim.timer.breached once at dueAt.
   * @param {Date|string|number} now
   * @returns {{ due: string[], breached: string[] }} timer ids
   */
  function sweep(now = ctx.clock.now()) {
    const nowIso = toDate(now).toISOString();
    const out = { due: [], breached: [] };
    const candidates = db.all(
      "SELECT id FROM regulatory_timers WHERE status IN ('running','due_soon') AND (due_at <= ? OR (status = 'running' AND warn_at IS NOT NULL AND warn_at <= ?)) ORDER BY due_at",
      nowIso, nowIso);
    for (const { id } of candidates) {
      let breachedClaim = null;
      db.transaction(() => {
        const r = row(id);
        if (!r || !['running', 'due_soon'].includes(r.status)) return; // already handled
        const base = { claimId: r.claim_id, timerId: r.id, definitionId: r.definition_id, state: r.state, kind: r.kind, dueAt: r.due_at };
        if (r.due_at <= nowIso) {
          db.update('regulatory_timers', r.id, { status: 'breached', breached_at: nowIso });
          ctx.audit.record({ actor: 'system:claims-timers', action: 'claim.timer.breached', entityType: 'claim', entityId: r.claim_id, details: { timerId: r.id, definitionId: r.definition_id } });
          ctx.bus.publish('claim.timer.breached', r.claim_id, { ...base, breachedAt: nowIso });
          out.breached.push(r.id);
          breachedClaim = { r, claimId: r.claim_id };
        } else if (r.status === 'running') {
          db.update('regulatory_timers', r.id, { status: 'due_soon' });
          ctx.audit.record({ actor: 'system:claims-timers', action: 'claim.timer.due', entityType: 'claim', entityId: r.claim_id, details: { timerId: r.id, definitionId: r.definition_id } });
          ctx.bus.publish('claim.timer.due', r.claim_id, { ...base, warnAt: r.warn_at });
          out.due.push(r.id);
        }
      });
      if (breachedClaim) applyBreach(breachedClaim.r, breachedClaim.claimId);
    }
    return out;
  }

  return { list, start, onStatusChanged, onTaskCompleted, onEvent, onStartEvent, sweep };
}
