// Config service: tenant configuration read, validate, version and publish.
// The tenant_configs table and version history live in core (ctx.tenants); this module adds
// schema + semantic validation, the read helpers named in modules.md#config, audit and events.
import { validate, fileResolver } from './validator.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../architecture/contracts/domain');
let schemaCache = null;
const resolver = fileResolver(SCHEMA_DIR);

/** Claim lifecycle states (architecture/overview.md section 7). */
export const LIFECYCLE_STATES = ['reported', 'validating', 'triaged', 'assigned', 'fast_tracked', 'in_review', 'pending_info', 'closed', 'withdrawn'];

const SECTIONS = ['branding', 'lobs', 'questionSets', 'rules', 'queues', 'timers', 'notifications', 'integrations', 'ai', 'security', 'fastTrack', 'severityBands', 'holidays'];
const META_KEYS = new Set(['$schema', 'tenantId', 'version', 'displayName', 'claimNumberPrefix', 'timeZone', 'locales', 'updatedAt', 'updatedBy']);

function tenantSchema() {
  schemaCache ??= JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'TenantConfig.schema.json'), 'utf8'));
  return schemaCache;
}

const factPaths = (cond, out = []) => {
  if (!cond || typeof cond !== 'object') return out;
  if (Array.isArray(cond.all)) cond.all.forEach((c) => factPaths(c, out));
  if (Array.isArray(cond.any)) cond.any.forEach((c) => factPaths(c, out));
  if (cond.not) factPaths(cond.not, out);
  if (typeof cond.fact === 'string') out.push(cond.fact);
  return out;
};

const dups = (items, key) => {
  const seen = new Set();
  const d = [];
  items.forEach((it, i) => { if (seen.has(it[key])) d.push([i, it[key]]); seen.add(it[key]); });
  return d;
};

/**
 * Schema plus semantic validation of a tenant config document. Pure: no I/O besides
 * reading the contract schemas.
 * @param {object} cfg candidate TenantConfig
 * @param {{ rules?: { validateRules?: (rules: object[]) => { valid: boolean, errors?: any[] } } }} [deps]
 *   rules is ctx.modules.rules; when absent or lacking validateRules the condition check is skipped (warning).
 * @returns {{ valid: boolean, errors: {path: string, code: string, message: string}[], warnings: {path: string, message: string}[] }}
 */
export function validateTenantConfig(cfg, deps = {}) {
  const errors = [];
  const warnings = [];
  const err = (path_, code, message) => errors.push({ path: path_, code, message });
  const warn = (path_, message) => warnings.push({ path: path_, message });

  const schemaResult = validate(tenantSchema(), cfg, { resolve: resolver });
  errors.push(...schemaResult.errors);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { valid: false, errors, warnings };
  // Semantic checks need a structurally sound document in the sections they read.
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

  const lobs = arr(cfg.lobs);
  const lobIds = new Set(lobs.map((l) => l.id));
  const knownStates = new Set(lobs.flatMap((l) => (Array.isArray(l.states) ? l.states : [])));
  for (const [i, id] of dups(lobs, 'id')) err(`/lobs/${i}/id`, 'duplicate_id', `duplicate line of business id "${id}"`);

  // Question sets
  const sets = arr(cfg.questionSets);
  const allQuestionIds = new Set();
  const typeById = new Map();
  for (const [i, id] of dups(sets, 'id')) err(`/questionSets/${i}/id`, 'duplicate_id', `duplicate question set id "${id}"`);
  sets.forEach((set, si) => {
    const base = `/questionSets/${si}`;
    if (set.lob && !lobIds.has(set.lob)) err(`${base}/lob`, 'unknown_lob', `question set references unknown line of business "${set.lob}"`);
    const lob = lobs.find((l) => l.id === set.lob);
    for (const lt of set.lossTypes ?? []) {
      if (lob?.lossTypes && !lob.lossTypes.some((x) => x.id === lt)) err(`${base}/lossTypes`, 'unknown_loss_type', `loss type "${lt}" is not defined on line of business "${set.lob}"`);
    }
    const qs = arr(set.questions);
    for (const [qi, id] of dups(qs, 'id')) err(`${base}/questions/${qi}/id`, 'duplicate_question_id', `duplicate question id "${id}" in question set "${set.id}"`);
    const idsInSet = new Set(qs.map((q) => q.id));
    qs.forEach((q, qi) => {
      const qp = `${base}/questions/${qi}`;
      allQuestionIds.add(q.id);
      if (typeById.has(q.id) && typeById.get(q.id) !== q.type) err(`${qp}/type`, 'question_type_conflict', `question id "${q.id}" is used with different types across question sets`);
      typeById.set(q.id, q.type);
      if ((q.type === 'select' || q.type === 'multiselect') && !(Array.isArray(q.options) && q.options.length)) err(`${qp}/options`, 'missing_options', `${q.type} question "${q.id}" needs options`);
      for (const key of ['showIf', 'requiredIf']) {
        for (const f of factPaths(q[key])) {
          const m = /^answers\.([a-z][a-z0-9_]*)/.exec(f);
          if (m && !idsInSet.has(m[1])) err(`${qp}/${key}`, 'unknown_question', `${key} on "${q.id}" reads answers.${m[1]}, which is not a question in set "${set.id}"`);
          if (m && m[1] === q.id) err(`${qp}/${key}`, 'self_reference', `${key} on "${q.id}" depends on its own answer`);
        }
      }
    });
  });
  for (const lob of lobs.filter((l) => l.enabled)) {
    if (!sets.some((s) => s.lob === lob.id)) warn('/questionSets', `enabled line of business "${lob.id}" has no question set`);
  }

  // Queues
  const queues = arr(cfg.queues);
  const queueIds = new Set(queues.map((q) => q.id));
  const adjusterIds = new Set(queues.flatMap((q) => (Array.isArray(q.adjusters) ? q.adjusters : [])));
  for (const [i, id] of dups(queues, 'id')) err(`/queues/${i}/id`, 'duplicate_id', `duplicate queue id "${id}"`);
  queues.forEach((q, i) => {
    for (const l of q.lobs ?? []) if (!lobIds.has(l)) err(`/queues/${i}/lobs`, 'unknown_lob', `queue "${q.id}" references unknown line of business "${l}"`);
  });
  if (cfg.fastTrack?.enabled && cfg.fastTrack.queue && !queueIds.has(cfg.fastTrack.queue)) err('/fastTrack/queue', 'unknown_queue', `fastTrack.queue "${cfg.fastTrack.queue}" is not a defined queue`);

  // Timers (needed before rule action checks)
  const timers = arr(cfg.timers);
  const timerIds = new Set(timers.map((t) => t.id));
  for (const [i, id] of dups(timers, 'id')) err(`/timers/${i}/id`, 'duplicate_id', `duplicate timer id "${id}"`);

  const checkActions = (actions, base) => {
    arr(actions).forEach((a, ai) => {
      const ap = `${base}/${ai}`;
      if (a.type === 'route_queue' && !a.queue) err(ap, 'missing_field', 'route_queue needs "queue"');
      if (a.queue && !queueIds.has(a.queue)) err(`${ap}/queue`, 'unknown_queue', `unknown queue "${a.queue}"`);
      if (a.task?.queue && !queueIds.has(a.task.queue)) err(`${ap}/task/queue`, 'unknown_queue', `unknown queue "${a.task.queue}"`);
      if (a.type === 'assign_adjuster' && !a.adjusterId) err(ap, 'missing_field', 'assign_adjuster needs "adjusterId"');
      if (a.adjusterId && !adjusterIds.has(a.adjusterId)) err(`${ap}/adjusterId`, 'unknown_adjuster', `adjuster "${a.adjusterId}" is not listed in any queue`);
      if (a.type === 'add_flag' && !a.flag) err(ap, 'missing_field', 'add_flag needs "flag"');
      if (a.type === 'add_task' && !a.task) err(ap, 'missing_field', 'add_task needs "task"');
      if (a.type === 'require_question' && !(a.questionId && allQuestionIds.has(a.questionId))) err(`${ap}/questionId`, 'unknown_question', `require_question references unknown question "${a.questionId ?? ''}"`);
      if (a.type === 'start_timer' && !(a.timerId && timerIds.has(a.timerId))) err(`${ap}/timerId`, 'unknown_timer', `start_timer references unknown timer "${a.timerId ?? ''}"`);
    });
  };

  // Rules
  const rules = arr(cfg.rules);
  for (const [i, id] of dups(rules, 'id')) err(`/rules/${i}/id`, 'duplicate_id', `duplicate rule id "${id}"`);
  rules.forEach((r, i) => {
    const rp = `/rules/${i}`;
    for (const l of r.appliesTo?.lobs ?? []) if (!lobIds.has(l)) err(`${rp}/appliesTo/lobs`, 'unknown_lob', `rule "${r.id}" applies to unknown line of business "${l}"`);
    for (const s of r.appliesTo?.states ?? []) if (!knownStates.has(s)) err(`${rp}/appliesTo/states`, 'unknown_state', `rule "${r.id}" applies to state "${s}", which no line of business serves`);
    checkActions(r.then, `${rp}/then`);
  });
  if (typeof deps.rules?.validateRules === 'function') {
    let report;
    try { report = deps.rules.validateRules(Array.isArray(cfg.rules) ? cfg.rules : []); } catch (e) { report = { valid: false, errors: [e.message] }; }
    for (const e of report?.errors ?? []) {
      if (typeof e === 'string') err('/rules', 'invalid_rule', e);
      else err(e.path ?? '/rules', e.code ?? 'invalid_rule', e.message ?? String(e));
    }
  } else {
    warn('/rules', 'rules module not available: rule conditions were checked against the schema only');
  }

  // Timers
  timers.forEach((t, i) => {
    const tp = `/timers/${i}`;
    if (t.state && !knownStates.has(t.state)) err(`${tp}/state`, 'unknown_state', `timer "${t.id}" is for state "${t.state}", which no line of business serves`);
    for (const l of t.lobs ?? []) {
      if (!lobIds.has(l)) err(`${tp}/lobs`, 'unknown_lob', `timer "${t.id}" references unknown line of business "${l}"`);
      else if (t.state && Array.isArray(lobs.find((x) => x.id === l)?.states) && !lobs.find((x) => x.id === l).states.includes(t.state)) err(`${tp}/lobs`, 'state_not_served', `line of business "${l}" does not serve state "${t.state}" (timer "${t.id}")`);
    }
    for (const s of t.stopOn?.toStatus ?? []) if (!LIFECYCLE_STATES.includes(s)) err(`${tp}/stopOn/toStatus`, 'unknown_status', `timer "${t.id}" stops on unknown claim status "${s}"`);
    checkActions(t.onBreach, `${tp}/onBreach`);
    if (!/illustrative/i.test(t.citation ?? '')) warn(`${tp}/citation`, `timer "${t.id}" is not labelled illustrative; demo deadlines must say "Illustrative, not legal advice"`);
  });

  if (cfg.notifications?.webhooks?.includePii === true) err('/notifications/webhooks/includePii', 'pii_not_allowed', 'webhooks cannot include PII in v1');
  if (cfg.ai?.provider === 'cascade' && !arr(cfg.ai.cascade).length) err('/ai/cascade', 'missing_cascade', 'ai.provider "cascade" needs at least one cascade entry');
  if (arr(cfg.ai?.cascade)[0] && cfg.ai.cascade[0].provider !== 'local') warn('/ai/cascade/0', 'first cascade entry is not the local provider');

  return { valid: errors.length === 0, errors, warnings };
}

const stripMeta = (c) => { const { version, updatedAt, updatedBy, ...rest } = c ?? {}; return rest; };

/** Which top-level sections differ between two configs (event enum names). */
export function changedSections(before, after) {
  const out = SECTIONS.filter((s) => JSON.stringify(before?.[s]) !== JSON.stringify(after?.[s]));
  const metaChanged = [...META_KEYS].some((k) => !['version', 'updatedAt', 'updatedBy'].includes(k) && JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
  if (metaChanged) out.push('other');
  return out;
}

const inLossTypes = (set, lossType) => !set.lossTypes?.length || (lossType != null && set.lossTypes.includes(lossType));
const inChannels = (set, channel) => !set.channels?.length || (channel != null && set.channels.includes(channel));

/**
 * Build the config service for one (tenant-bound) context.
 * @param {object} ctx tenant-bound ctx (ctx.tenant.id) or root ctx (methods then need tenantId option)
 */
export function createService(ctx) {
  const tenantId = () => ctx.tenant?.id;
  const need = () => {
    const cfg = tenantId() ? ctx.tenants.get(tenantId()) : null;
    if (!cfg) throw new ctx.AppError('not_found', 'Tenant configuration not found', 404);
    return { ...cfg, version: ctx.tenants.version(tenantId()) };
  };
  const rulesApi = () => ctx.modules?.rules;

  const svc = {
    /** @returns {object} current TenantConfig; version is the stored version number */
    getTenantConfig: () => need(),

    /** @returns {{tenantId, displayName, branding, lobs, locales}} UI-safe subset */
    getPublicConfig() {
      const c = need();
      return { tenantId: c.tenantId ?? tenantId(), displayName: c.displayName, branding: c.branding, lobs: c.lobs, locales: c.locales ?? ['en'] };
    },

    /** Most specific matching question set (lossType and channel narrow; highest version breaks ties). */
    getQuestionSet({ lob, lossType, channel } = {}) {
      const matches = (need().questionSets ?? []).filter((s) => s.lob === lob && inLossTypes(s, lossType) && inChannels(s, channel));
      if (!matches.length) throw new ctx.AppError('not_found', `No question set for lob "${lob}"`, 404);
      const score = (s) => (s.lossTypes?.length ? 2 : 0) + (s.channels?.length ? 1 : 0);
      return matches.sort((a, b) => score(b) - score(a) || b.version - a.version)[0];
    },

    /** Enabled rules for a stage filtered by appliesTo, sorted by priority then id. */
    getRules({ stage, lob, state, lossType, at } = {}) {
      const when = (at ? new Date(at) : ctx.clock.now()).toISOString().slice(0, 10);
      return (need().rules ?? []).filter((r) => {
        if (r.enabled === false || (stage && r.stage !== stage)) return false;
        const a = r.appliesTo ?? {};
        if (a.lobs?.length && (!lob || !a.lobs.includes(lob))) return false;
        if (a.states?.length && (!state || !a.states.includes(state))) return false;
        if (a.lossTypes?.length && (!lossType || !a.lossTypes.includes(lossType))) return false;
        if (a.effectiveFrom && when < a.effectiveFrom) return false;
        if (a.effectiveTo && when > a.effectiveTo) return false;
        return true;
      }).sort((x, y) => (x.priority ?? 100) - (y.priority ?? 100) || x.id.localeCompare(y.id));
    },

    getTimerDefinitions: ({ state, lob } = {}) => (need().timers ?? []).filter((t) => (!state || t.state === state) && (!lob || !t.lobs?.length || t.lobs.includes(lob))),

    getQueues: () => need().queues ?? [],

    /** Dry-run validation (schema + semantics). @returns {{valid, errors, warnings}} */
    validateTenantConfig: (doc) => validateTenantConfig(doc, { rules: rulesApi() }),

    /**
     * Save a new version. Throws 403 tenant_mismatch, 409 version_conflict, 422 validation_failed
     * (err.report holds the ValidationReport). Identical content is a no-op (no version, no event).
     * @returns {object} saved TenantConfig
     */
    putTenantConfig(doc, { expectedVersion, actor = 'system' } = {}) {
      const id = tenantId();
      if (doc && typeof doc === 'object' && doc.tenantId && doc.tenantId !== id) throw new ctx.AppError('tenant_mismatch', 'tenantId in body does not match the authenticated tenant', 403);
      const current = ctx.tenants.version(id);
      if (expectedVersion != null && Number(expectedVersion) !== current) throw new ctx.AppError('version_conflict', `Config is at version ${current}, not ${expectedVersion}`, 409);
      const report = svc.validateTenantConfig(doc);
      if (!report.valid) {
        const e = new ctx.AppError('validation_failed', 'Tenant config failed validation', 422);
        e.report = report;
        throw e;
      }
      const before = ctx.tenants.get(id);
      if (before && JSON.stringify(stripMeta(before)) === JSON.stringify(stripMeta(doc))) return need();
      const version = current + 1;
      const saved = { ...doc, version, updatedAt: ctx.clock.nowIso(), updatedBy: actor };
      ctx.tenants.put(id, saved, actor);
      const sections = changedSections(before, saved);
      ctx.audit.record(id, { actor, action: 'tenant.config.updated', entityType: 'tenant_config', entityId: id, details: { version, previousVersion: current || undefined, changedSections: sections } });
      const data = { version, changedSections: sections.length ? sections : ['other'] };
      if (current) data.previousVersion = current;
      ctx.bus.publish(id, 'tenant.config.updated', id, data);
      return need();
    },
  };
  return svc;
}
