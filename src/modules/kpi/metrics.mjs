// Pure KPI metric functions over normalised per-claim records. No I/O, no clock.
// A record is one claim in the period; a field is `undefined` when its source was unavailable.
//
// Record shape (all optional except claimId):
//   { claimId, status, channel, reportedAt, actorRole, actorType, flags[], locale,
//     fastTrack, manualTaskCount, fraudFlag, subrogationFlag, aiFactCount,
//     verifiedAt, ackAt, assignedAt, timers: [{ status }] }

/** Verification counts as "at intake" when it completed within this many minutes of the report. */
export const INTAKE_VERIFY_WINDOW_MIN = 15;
export const DIGITAL_CHANNELS = ['claimant_web', 'claimant_mobile', 'web', 'mobile', 'chat'];
export const ASSISTED_ROLES = ['csr', 'agent', 'adjuster', 'supervisor'];

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Median of finite numbers; null for an empty list. */
export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** numerator / denominator, or null when the denominator is zero or either side is not finite. */
export function ratio(numerator, denominator, dp = 4) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return round(numerator / denominator, dp);
}

const minutesBetween = (from, to) => {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / 60000;
};

const share = (records, pred) => ({
  numerator: records.filter(pred).length,
  denominator: records.length,
});

const durations = (records, endKey) => records
  .map((r) => (r[endKey] && r.reportedAt ? minutesBetween(r.reportedAt, r[endKey]) : null))
  .filter((x) => x !== null);

const timerCounts = (records) => {
  const all = records.flatMap((r) => r.timers ?? []);
  const met = all.filter((t) => t.status === 'met').length;
  const breached = all.filter((t) => t.status === 'breached').length;
  return { met, breached, resolved: met + breached };
};

/**
 * Metric definitions. `requires` lists the data sources a metric needs (see service.mjs);
 * `compute(records)` returns `{ value, numerator, denominator }`.
 * Ratios are 0..1 (unit 'ratio'); medians are minutes.
 */
export const METRIC_DEFS = [
  {
    id: 'stp_rate', label: 'Straight-through processing rate', valueDriver: 'VD-1', unit: 'ratio', requires: ['routing', 'tasks'],
    definition: 'Claims fast-tracked by routing with no manually created (user-actor) task and not withdrawn, divided by all claims reported in the period.',
    compute(rs) {
      const s = share(rs, (r) => r.fastTrack === true && r.manualTaskCount === 0 && r.status !== 'withdrawn');
      return { ...s, value: ratio(s.numerator, s.denominator) };
    },
  },
  {
    id: 'automated_capture_rate', label: 'Automated capture rate', valueDriver: 'VD-1', unit: 'ratio', requires: ['evidence'],
    definition: 'Claims with at least one accepted fact whose provenance source is ai_extraction, divided by all claims reported in the period.',
    compute(rs) {
      const s = share(rs, (r) => r.aiFactCount > 0);
      return { ...s, value: ratio(s.numerator, s.denominator) };
    },
  },
  {
    id: 'median_minutes_to_acknowledgment', label: 'Median minutes to acknowledgment', valueDriver: 'VD-2', unit: 'minutes', requires: ['events', 'timers'],
    definition: 'Median minutes from claim report to acknowledgment. Acknowledgment time is the first claim.acknowledged event when the tenant emits one, otherwise the metAt of the claim\'s acknowledge timer. numerator = claims with a measurable time, denominator = all claims; null when none.',
    compute(rs) {
      const d = durations(rs, 'ackAt');
      const m = median(d);
      return { value: m === null ? null : round(m, 2), numerator: d.length, denominator: rs.length };
    },
  },
  {
    id: 'median_minutes_to_assignment', label: 'Median minutes to assignment', valueDriver: 'VD-2', unit: 'minutes', requires: ['events', 'routing'],
    definition: 'Median minutes from claim report to routing (claim.routed event time, else the routing decision time). numerator = claims with a measurable time, denominator = all claims; null when none.',
    compute(rs) {
      const d = durations(rs, 'assignedAt');
      const m = median(d);
      return { value: m === null ? null : round(m, 2), numerator: d.length, denominator: rs.length };
    },
  },
  {
    id: 'coverage_verified_at_intake_rate', label: 'Coverage verified at intake', valueDriver: 'VD-4', unit: 'ratio', requires: ['coverage'],
    definition: `Claims whose coverage verification completed within ${INTAKE_VERIFY_WINDOW_MIN} minutes of the report, divided by all claims reported in the period.`,
    compute(rs) {
      const s = share(rs, (r) => {
        const m = r.verifiedAt && r.reportedAt ? minutesBetween(r.reportedAt, r.verifiedAt) : null;
        return m !== null && m <= INTAKE_VERIFY_WINDOW_MIN;
      });
      return { ...s, value: ratio(s.numerator, s.denominator) };
    },
  },
  {
    id: 'fraud_flag_rate', label: 'Fraud flag rate', valueDriver: 'VD-4', unit: 'ratio', requires: ['triage'],
    definition: 'Claims whose latest triage refers to SIU (fraud.referToSiu) or that carry the siu flag, divided by all claims reported in the period.',
    compute(rs) {
      const s = share(rs, (r) => r.fraudFlag === true);
      return { ...s, value: ratio(s.numerator, s.denominator) };
    },
  },
  {
    id: 'subrogation_flag_rate', label: 'Subrogation flag rate', valueDriver: 'VD-5', unit: 'ratio', requires: ['triage'],
    definition: 'Claims whose latest triage sets subrogation.flag or that carry the subrogation flag, divided by all claims reported in the period.',
    compute(rs) {
      const s = share(rs, (r) => r.subrogationFlag === true);
      return { ...s, value: ratio(s.numerator, s.denominator) };
    },
  },
  {
    id: 'digital_self_service_share', label: 'Digital self-service share', valueDriver: 'VD-6', unit: 'ratio', requires: [],
    definition: 'Claims reported through a digital channel (claimant_web, claimant_mobile) by someone other than a csr, agent, adjuster or supervisor, divided by all claims reported in the period.',
    compute(rs) {
      const s = share(rs, (r) => DIGITAL_CHANNELS.includes(r.channel) && !ASSISTED_ROLES.includes(r.actorRole));
      return { ...s, value: ratio(s.numerator, s.denominator) };
    },
  },
  {
    id: 'spanish_session_share', label: 'Spanish-session share', valueDriver: 'VD-6', unit: 'ratio', requires: ['intake'],
    definition: 'Claims whose intake session locale starts with "es", divided by all claims reported in the period.',
    compute(rs) {
      const s = share(rs, (r) => typeof r.locale === 'string' && /^es(\b|-|_)/i.test(r.locale));
      return { ...s, value: ratio(s.numerator, s.denominator) };
    },
  },
  {
    id: 'regulatory_timers_met', label: 'Regulatory timers met', valueDriver: 'VD-7', unit: 'ratio', requires: ['timers'],
    definition: 'Timers with status met divided by timers that are met or breached, across claims reported in the period. Running, paused and cancelled timers are excluded.',
    compute(rs) {
      const t = timerCounts(rs);
      return { numerator: t.met, denominator: t.resolved, value: ratio(t.met, t.resolved) };
    },
  },
  {
    id: 'regulatory_timers_breached', label: 'Regulatory timers breached', valueDriver: 'VD-7', unit: 'ratio', requires: ['timers'],
    definition: 'Timers with status breached divided by timers that are met or breached, across claims reported in the period.',
    compute(rs) {
      const t = timerCounts(rs);
      return { numerator: t.breached, denominator: t.resolved, value: ratio(t.breached, t.resolved) };
    },
  },
];

/**
 * Compute every metric. A metric whose required source is not 'ok' yields value null plus a note;
 * a metric that throws yields value null plus a note. Never throws.
 * @param {object[]} records normalised per-claim records
 * @param {Record<string, 'ok'|'unavailable'|'failed'>} sources source health
 * @returns {{ id: string, label: string, valueDriver: string, value: number|null, unit: string, numerator: number|null, denominator: number|null, definition: string, note?: string }[]}
 */
export function computeMetrics(records, sources = {}) {
  return METRIC_DEFS.map((def) => {
    const base = { id: def.id, label: def.label, valueDriver: def.valueDriver, unit: def.unit, definition: def.definition };
    const bad = def.requires.filter((s) => sources[s] && sources[s] !== 'ok');
    if (bad.length) {
      return { ...base, value: null, numerator: null, denominator: null, note: `source ${bad.map((s) => `${s} ${sources[s]}`).join(', ')}` };
    }
    try {
      const out = def.compute(records);
      const value = Number.isFinite(out.value) ? out.value : null;
      return { ...base, value, numerator: out.numerator, denominator: out.denominator };
    } catch {
      return { ...base, value: null, numerator: null, denominator: null, note: 'computation failed' };
    }
  });
}
