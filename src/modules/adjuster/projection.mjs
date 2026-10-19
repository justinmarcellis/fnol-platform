// Inbox projection maintained from claim.* events. Events carry ids and codes only (no PII).

const uniq = (a) => [...new Set(a)];

/** Merge a patch into the inbox row for a claim (insert when missing). */
export function upsertRow(ctx, claimId, patch, { addFlags = [], removeFlags = [] } = {}) {
  const db = ctx.db;
  const now = ctx.clock.nowIso();
  const cur = db.get('SELECT * FROM adjuster_inbox WHERE claim_id = ?', claimId);
  const flags = uniq([...(cur ? db.parseJson(cur.flags, []) : []), ...addFlags]).filter((f) => !removeFlags.includes(f));
  if (!cur) {
    db.insert('adjuster_inbox', { claim_id: claimId, flags: JSON.stringify(flags), updated_at: now, ...patch });
  } else {
    db.run(
      `UPDATE adjuster_inbox SET ${[...Object.keys(patch), 'flags', 'updated_at'].map((k) => `${k} = ?`).join(', ')} WHERE claim_id = ?`,
      ...Object.values(patch), JSON.stringify(flags), now, claimId,
    );
  }
}

const handlers = {
  'claim.reported': (ctx, d, evt) => upsertRow(ctx, d.claimId, {
    claim_number: d.claimNumber, lob: d.lob, status: 'reported', reported_at: d.reportedAt ?? evt.time ?? null,
  }, { addFlags: d.injuriesReported ? ['injury'] : [] }),

  'claim.triaged': (ctx, d) => upsertRow(ctx, d.claimId, {
    severity: d.severityScore, complexity: d.complexity,
  }, {
    addFlags: [...(d.fraudScore >= 70 ? ['siu'] : []), ...(d.subrogation ? ['subrogation'] : [])],
    removeFlags: [...(d.fraudScore >= 70 ? [] : ['siu']), ...(d.subrogation ? [] : ['subrogation'])],
  }),

  'claim.routed': (ctx, d) => upsertRow(ctx, d.claimId, {
    queue: d.queue, adjuster_id: d.adjusterId ?? null, status: d.outcome,
  }),

  'claim.status.changed': (ctx, d) => upsertRow(ctx, d.claimId, { status: d.to }),

  'claim.timer.due': (ctx, d) => upsertRow(ctx, d.claimId, {
    next_due_at: d.dueAt,
    next_timer: JSON.stringify({ id: d.timerId, claimId: d.claimId, kind: d.kind, state: d.state, dueAt: d.dueAt, warnAt: d.warnAt, status: 'due_soon' }),
  }, { addFlags: ['timer_due'] }),

  'claim.timer.breached': (ctx, d) => upsertRow(ctx, d.claimId, {
    next_due_at: d.dueAt,
    next_timer: JSON.stringify({ id: d.timerId, claimId: d.claimId, kind: d.kind, state: d.state, dueAt: d.dueAt, warnAt: d.warnAt, status: 'breached' }),
  }, { addFlags: ['timer_breached'], removeFlags: ['timer_due'] }),
};

export const EVENT_TYPES = Object.keys(handlers);

/** Subscribe all projection handlers; each runs under the event's tenant-bound ctx. */
export function subscribeProjection(bus, rootCtx) {
  for (const type of EVENT_TYPES) {
    bus.on(type, async (evt, tctx) => {
      const t = tctx ?? rootCtx.forTenant(evt?.tenantid ?? evt?.tenantId);
      const claimId = evt?.data?.claimId;
      if (!claimId) { t.log?.warn?.('adjuster projection: event without claimId skipped', { type, eventId: evt?.id }); return; }
      try {
        handlers[type](t, evt.data, evt);
      } catch (e) {
        // The projection is rebuildable from the outbox, so a bad event must not poison the bus.
        t.log?.warn?.('adjuster projection: handler failed; skipped', { type, claimId, error: e?.code ?? e?.message });
      }
    }, { name: `adjuster:${type}` });
  }
}

/** Apply one event directly (used by tests and rebuild). */
export function applyEvent(ctx, evt) {
  handlers[evt.type]?.(ctx, evt.data, evt);
}

/** Rebuild the projection for the bound tenant from the outbox, in order. */
export function rebuild(ctx) {
  ctx.db.run('DELETE FROM adjuster_inbox');
  for (const row of ctx.bus.outbox(ctx.tenant.id)) {
    const evt = ctx.db.parseJson(row.event, null);
    if (evt?.data?.claimId) applyEvent(ctx, evt);
  }
}
