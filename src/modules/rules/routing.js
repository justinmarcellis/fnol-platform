// Pure routing decision logic: turns fired routing actions plus tenant queue config into
// queue / fast-track / reasons. No I/O. Adjuster selection (stateful) lives in service.js.

const DEFAULT_FT = { maxSeverity: 25, maxFraudScore: 20, queue: 'fast_track' };

/** Fast-track settings with schema defaults applied. */
export function fastTrackSettings(config) {
  return { enabled: true, ...DEFAULT_FT, ...(config?.fastTrack ?? {}) };
}

/** Queue used by a tenant that configures no queues at all (platform default, see knownQueues). */
export const PLATFORM_DEFAULT_QUEUE = 'general';

/**
 * Queue ids a decision may resolve to: the configured queues, or, for a tenant with no queues
 * (a bare tenant such as the e2e-demo harness tenant), the implicit platform default and fast-track queues.
 * @returns {string[]}
 */
export function knownQueues(config) {
  const queues = config?.queues ?? [];
  if (queues.length) return queues.map((q) => q.id);
  return [config?.defaultQueue || PLATFORM_DEFAULT_QUEUE, fastTrackSettings(config).queue];
}

/**
 * Queue used when no rule picked one (or a route_queue action named no queue): config.defaultQueue,
 * else the first queue serving the LOB, else any non fast-track queue, else the platform default.
 */
export function defaultQueueFor(config, lob) {
  const queues = config?.queues ?? [];
  const ft = fastTrackSettings(config).queue;
  if (config?.defaultQueue && (queues.some((q) => q.id === config.defaultQueue) || !queues.length)) return config.defaultQueue;
  const forLob = queues.find((q) => q.id !== ft && (!q.lobs?.length || q.lobs.includes(lob)));
  return (forLob ?? queues.find((q) => q.id !== ft) ?? queues[0])?.id ?? PLATFORM_DEFAULT_QUEUE;
}

/**
 * Platform default routing actions for a tenant that defines no routing-stage rules: fast track when
 * triage marked the claim eligible (the fast-track guard still applies), otherwise the default queue.
 * @returns {object[]} actions in the same shape the rule engine emits
 */
export function platformDefaultActions(triage) {
  return triage?.fastTrackEligible === true ? [{ type: 'fast_track', ruleId: 'PLATFORM-STP-DEFAULT' }] : [];
}

/**
 * Fast-track guard: reasons it must be denied even when a rule asked for it.
 * @returns {string[]} denial reasons (empty when eligible)
 */
export function fastTrackDenials({ settings, triage, coverage, estimate }) {
  const out = [];
  if (settings.enabled === false) out.push('fast track disabled for tenant');
  if (!coverage || coverage.outcome !== 'covered') out.push(`coverage outcome is ${coverage?.outcome ?? 'unverified'}, not covered`);
  if (!triage) { out.push('no triage result'); return out; }
  if (triage.fastTrackEligible === false) out.push('triage marked claim not fast-track eligible');
  if (typeof triage.severityScore === 'number' && triage.severityScore > settings.maxSeverity) {
    out.push(`severity ${triage.severityScore} above fast-track limit ${settings.maxSeverity}`);
  }
  const fraud = triage.fraud?.score;
  if (typeof fraud === 'number' && fraud > settings.maxFraudScore) out.push(`fraud score ${fraud} above fast-track limit ${settings.maxFraudScore}`);
  const max = settings.maxEstimate?.amount;
  const amt = estimate?.amount;
  if (typeof max === 'number' && typeof amt === 'number' && amt > max) out.push(`estimate ${amt} above fast-track limit ${max}`);
  return out;
}

/**
 * Combine routing-stage actions into a decision. The first route_queue wins (rules run by ascending priority, so
 * specific low-number rules beat the priority-90 defaults); deny_fast_track beats fast_track; an approved
 * fast track beats default queues.
 * @param {{ actions: object[], config: object, lob: string, triage?: object, coverage?: object, estimate?: object }} input
 * @returns {{ queue?: string, adjusterId?: string, fastTrack: boolean, reasons: string[] }}
 */
export function decideRouting({ actions, config, lob, triage, coverage, estimate }) {
  const settings = fastTrackSettings(config);
  const reasons = [];
  const queues = [];
  let adjusterId;
  let wantsFt = false;
  const denials = [];
  for (const a of actions) {
    if (a.type === 'route_queue') {
      if (typeof a.queue === 'string' && a.queue) { queues.push(a.queue); reasons.push(`${a.ruleId}: route to ${a.queue}`); }
      else reasons.push(`${a.ruleId}: route_queue names no queue; tenant default applies`);
    }
    else if (a.type === 'assign_adjuster') { adjusterId = a.adjusterId; reasons.push(`${a.ruleId}: assign ${a.adjusterId}`); }
    else if (a.type === 'fast_track') { wantsFt = true; reasons.push(`${a.ruleId}: fast track requested`); }
    else if (a.type === 'deny_fast_track') { denials.push(a.reason ?? 'denied'); reasons.push(`${a.ruleId}: fast track denied (${a.reason ?? 'no reason given'})`); }
  }

  let fastTrack = false;
  if (wantsFt) {
    const blockers = denials.length ? denials : fastTrackDenials({ settings, triage, coverage, estimate });
    if (denials.length === 0 && blockers.length === 0) {
      fastTrack = true;
      reasons.push(`fast track approved (severity ${triage?.severityScore}, fraud ${triage?.fraud?.score ?? 0})`);
    } else if (denials.length === 0) {
      reasons.push(...blockers.map((b) => `fast track blocked: ${b}`));
    }
  } else if (denials.length) {
    reasons.push('fast track not requested');
  }

  // The fast-track queue only applies when the claim really is fast tracked.
  let queue;
  if (fastTrack) {
    // Approved fast track beats default queues; the queue is the one named by the same rule, else the tenant setting.
    const ftRule = actions.find((a) => a.type === 'fast_track').ruleId;
    const own = actions.filter((a) => a.type === 'route_queue' && a.ruleId === ftRule).pop();
    queue = own?.queue ?? settings.queue;
  } else {
    if (queues.includes(settings.queue)) reasons.push(`${settings.queue} queue skipped because the claim is not fast tracked`);
    // Rules run in ascending priority, so the first route_queue is the highest-precedence one.
    queue = queues.find((q) => q !== settings.queue);
  }
  if (!queue) {
    queue = defaultQueueFor(config, lob);
    if (queue) reasons.push(`default queue ${queue}`);
  }
  return { queue, adjusterId, fastTrack, reasons };
}
