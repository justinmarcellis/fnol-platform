// Rule evaluation and rule validation. Pure apart from reading the tenant's rules through `getRules`.
import { evaluateCondition, validateCondition, ConditionError } from './condition.js';

export const STAGES = ['intake', 'triage', 'routing', 'post_routing'];
export const ACTION_TYPES = [
  'route_queue', 'assign_adjuster', 'fast_track', 'deny_fast_track', 'add_flag', 'add_task', 'require_question',
  'add_severity', 'set_complexity', 'refer_siu', 'start_timer', 'notify', 'block_submit',
];
const REQUIRED_FIELD = {
  route_queue: 'queue', assign_adjuster: 'adjusterId', add_flag: 'flag', add_task: 'task',
  require_question: 'questionId', add_severity: 'points', set_complexity: 'complexity', start_timer: 'timerId', notify: 'template',
};

/**
 * Enabled rules for a stage, filtered by appliesTo and sorted by priority then id.
 * Used only when the config module is unavailable; mirrors config.getRules.
 */
export function filterRules(rules, { stage, lob, state, lossType, at } = {}) {
  const when = String(at ?? new Date().toISOString()).slice(0, 10);
  return (rules ?? []).filter((r) => {
    if (r.enabled === false || (stage && r.stage !== stage)) return false;
    const a = r.appliesTo ?? {};
    if (a.lobs?.length && (!lob || !a.lobs.includes(lob))) return false;
    if (a.states?.length && (!state || !a.states.includes(state))) return false;
    if (a.lossTypes?.length && (!lossType || !a.lossTypes.includes(lossType))) return false;
    if (a.effectiveFrom && when < a.effectiveFrom) return false;
    if (a.effectiveTo && when > a.effectiveTo) return false;
    return true;
  }).sort((x, y) => (x.priority ?? 100) - (y.priority ?? 100) || x.id.localeCompare(y.id));
}

/**
 * Run the given (already filtered and ordered) rules against facts.
 * All matching rules fire unless one has stopOnMatch. A rule whose condition is malformed does not fire
 * and is reported in the trace with an `error`.
 * @param {object[]} rules
 * @param {object} facts
 * @returns {{ fired: { ruleId: string, actions: object[] }[], actions: object[], trace: object[] }}
 */
export function runRules(rules, facts) {
  const fired = [];
  const actions = [];
  const trace = [];
  for (const rule of rules) {
    let out;
    try {
      out = evaluateCondition(rule.when, facts);
    } catch (e) {
      if (!(e instanceof ConditionError)) throw e;
      trace.push({ ruleId: rule.id, matched: false, error: e.message, leaves: [] });
      continue;
    }
    trace.push({ ruleId: rule.id, matched: out.result, leaves: out.trace });
    if (!out.result) continue;
    const acts = (rule.then ?? []).map((a) => ({ ...a }));
    fired.push({ ruleId: rule.id, actions: acts });
    for (const a of acts) actions.push({ ...a, ruleId: rule.id });
    if (rule.stopOnMatch) break;
  }
  return { fired, actions, trace };
}

/**
 * Validate a tenant's rules: shape, unique ids, stage, actions and conditions.
 * Used by config.validateTenantConfig. Synchronous.
 * @param {object[]} rules
 * @returns {{ valid: boolean, errors: { path: string, code: string, message: string }[] }}
 */
export function validateRules(rules) {
  const errors = [];
  const err = (path, code, message) => errors.push({ path, code, message });
  if (!Array.isArray(rules)) return { valid: false, errors: [{ path: '/rules', code: 'invalid_rules', message: 'rules must be an array' }] };
  const seen = new Set();
  rules.forEach((r, i) => {
    const p = `/rules/${i}`;
    if (!r || typeof r !== 'object') { err(p, 'invalid_rule', 'rule must be an object'); return; }
    if (typeof r.id !== 'string' || !r.id) err(`${p}/id`, 'invalid_rule', 'rule needs an id');
    else if (seen.has(r.id)) err(`${p}/id`, 'duplicate_id', `duplicate rule id "${r.id}"`);
    else seen.add(r.id);
    if (!STAGES.includes(r.stage)) err(`${p}/stage`, 'invalid_stage', `stage must be one of ${STAGES.join(', ')}`);
    if (r.priority !== undefined && !Number.isInteger(r.priority)) err(`${p}/priority`, 'invalid_rule', 'priority must be an integer');
    if (r.when === undefined) err(`${p}/when`, 'invalid_condition', 'rule needs a when condition');
    else errors.push(...validateCondition(r.when, `${p}/when`));
    if (!Array.isArray(r.then) || r.then.length === 0) { err(`${p}/then`, 'invalid_rule', 'rule needs at least one action'); return; }
    r.then.forEach((a, j) => {
      const ap = `${p}/then/${j}`;
      if (!a || !ACTION_TYPES.includes(a.type)) { err(`${ap}/type`, 'unknown_action', `unknown action type "${a?.type}"`); return; }
      const need = REQUIRED_FIELD[a.type];
      if (need && (a[need] === undefined || a[need] === null || a[need] === '')) err(`${ap}/${need}`, 'missing_action_field', `${a.type} needs "${need}"`);
      if (a.type === 'add_task' && a.task && typeof a.task === 'object' && !a.task.type && !a.task.title) err(`${ap}/task`, 'missing_action_field', 'add_task needs task.type or task.title');
    });
    if (r.stage === 'intake') {
      r.then.forEach((a, j) => {
        if (['route_queue', 'assign_adjuster', 'fast_track', 'deny_fast_track'].includes(a?.type)) err(`${p}/then/${j}/type`, 'action_stage_mismatch', `${a.type} is not allowed at the intake stage`);
      });
    }
  });
  return { valid: errors.length === 0, errors };
}
