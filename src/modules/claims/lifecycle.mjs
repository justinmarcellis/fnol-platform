// Claim lifecycle state machine (architecture/overview.md section 7).
// Claims is the only module that changes Claim.status; this table is the single source.

export const STATUSES = ['reported', 'validating', 'triaged', 'assigned', 'fast_tracked', 'in_review', 'pending_info', 'closed', 'withdrawn'];
export const TERMINAL = ['closed', 'withdrawn'];
export const CLOSE_REASONS = ['paid', 'denied', 'no_coverage', 'duplicate', 'withdrawn_by_insured', 'below_deductible', 'other'];

const SYS = 'system';
const ADJ = ['adjuster', 'supervisor'];
const SUP = ['supervisor'];
const PRE_ASSIGN = ['csr', 'supervisor'];

/** from -> to -> roles allowed. 'system' is the platform itself (event subscribers, adapters). */
export const TRANSITIONS = {
  reported: { validating: [SYS], withdrawn: PRE_ASSIGN },
  validating: { triaged: [SYS], withdrawn: PRE_ASSIGN },
  triaged: { assigned: [SYS, 'supervisor'], fast_tracked: [SYS, 'supervisor'], withdrawn: PRE_ASSIGN },
  assigned: { in_review: ADJ, withdrawn: SUP },
  fast_tracked: { in_review: [SYS, 'supervisor'], closed: [SYS, 'supervisor'], withdrawn: SUP },
  in_review: { pending_info: ADJ, closed: ADJ, withdrawn: SUP },
  pending_info: { in_review: ADJ, withdrawn: SUP },
  closed: { in_review: SUP },
  withdrawn: {},
};

const ELEVATED = new Set(['carrier_admin', 'platform_admin']);

/** True when a transition exists in the table (ignoring who asks). */
export function isLegal(from, to) {
  return Boolean(TRANSITIONS[from] && Object.hasOwn(TRANSITIONS[from], to));
}

/**
 * Check a transition. Returns null when allowed, or `{ status, code, message }`.
 * @param {string} from
 * @param {string} to
 * @param {{ type?: string, role?: string, roles?: string[] }} actor
 * @param {{ closeReason?: string }} [opts]
 */
export function checkTransition(from, to, actor = {}, opts = {}) {
  if (!STATUSES.includes(to)) return { status: 422, code: 'invalid_status', message: `Unknown status ${to}` };
  if (!isLegal(from, to)) return { status: 409, code: 'invalid_transition', message: `Cannot move a claim from ${from} to ${to}` };
  if (to === 'closed' && !opts.closeReason) return { status: 422, code: 'close_reason_required', message: 'closeReason is required to close a claim' };
  if (opts.closeReason && !CLOSE_REASONS.includes(opts.closeReason)) return { status: 422, code: 'invalid_close_reason', message: `Unknown closeReason ${opts.closeReason}` };
  const allowed = TRANSITIONS[from][to];
  const roles = [...(actor.roles ?? []), ...(actor.role ? [actor.role] : [])];
  const isSystem = actor.type === 'system' || roles.includes(SYS);
  if (isSystem) return allowed.includes(SYS) ? null : { status: 403, code: 'forbidden', message: `System may not move a claim from ${from} to ${to}` };
  if (roles.some((r) => ELEVATED.has(r)) || roles.some((r) => allowed.includes(r))) return null;
  return { status: 403, code: 'forbidden', message: `Role not permitted to move a claim from ${from} to ${to}` };
}
