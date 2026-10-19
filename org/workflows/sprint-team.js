export const meta = {
  name: 'sprint-team-delivery',
  description: 'One sprint for a group of teams: manager plans tickets, ICs build in parallel, acceptance review with one rework loop',
  phases: [
    { title: 'Plan', detail: 'team managers decompose stories into tickets' },
    { title: 'Build', detail: 'IC agents, one per ticket' },
    { title: 'Review', detail: 'acceptance reviewer per ticket, one rework loop' },
  ],
}

const S = args.sprint
const COMMON = `You are an agent at a small AI-staffed software company building a COTS First Notice of Loss (FNOL) platform proof of concept that any P&C insurer could license. Repo: /home/user/fnol-platform (Node 22, plain JavaScript ES modules, zero-dependency core).
Before working read: org/playbooks/role-prompts.md (Common + your role), org/playbooks/standards.md, org/decisions/*.md, architecture/core-runtime-api.md (the core API as built; includes tenant-bound ctx addendum), architecture/contracts/modules.md and the specific contract files your ticket links. Do not re-decide ADRs or contracts. If a contract is wrong or missing something, post a contract-change request to the architecture hub (node org/cli.mjs post architecture contract-change "...") and implement the smallest compatible addition, documenting it in your result.
Fabric: AGENT_ID=<your id> node org/cli.mjs ... (ticket <ID> status in_progress|review, post <hub> <type> "<text>" --ticket <ID>). Read your team hub and the architecture hub before starting (node org/cli.mjs hub <hub>).
Only synthetic, fictional data. No real carrier names, people or logos. No secrets in git. Do not git commit. Do not edit package.json (platform team owns it) unless you are on the platform team.
Other agents are writing other folders at the same time. Write ONLY your ticket's paths. Run only your own tests (node --test --disable-warning=ExperimentalWarning <your test paths>), not the whole suite, since other teams' work may be mid-flight.`

const TICKETS = { type: 'object', properties: {
  tickets: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, title: { type: 'string' }, story: { type: 'string' }, points: { type: 'number' },
    tier: { type: 'string', enum: ['strong', 'mid', 'fast'] }, owner: { type: 'string' },
    paths: { type: 'array', items: { type: 'string' } }, contracts: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'array', items: { type: 'string' } }, brief: { type: 'string' },
    valueDrivers: { type: 'array', items: { type: 'string' } }, requirements: { type: 'array', items: { type: 'string' } },
  }, required: ['id', 'title', 'points', 'tier', 'owner', 'paths', 'acceptance', 'brief'] } },
  notes: { type: 'string' },
}, required: ['tickets'] }

const BUILD = { type: 'object', properties: {
  summary: { type: 'string' }, filesWritten: { type: 'array', items: { type: 'string' } },
  testsRun: { type: 'string' }, testsPassed: { type: 'boolean' },
  assumptions: { type: 'array', items: { type: 'string' } }, contractChanges: { type: 'array', items: { type: 'string' } },
}, required: ['summary', 'filesWritten', 'testsRun', 'testsPassed'] }

const VERDICT = { type: 'object', properties: {
  verdict: { type: 'string', enum: ['accept', 'rework'] },
  criteria: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['criterion', 'met', 'evidence'] } },
  reasons: { type: 'string' }, testsPassed: { type: 'boolean' },
}, required: ['verdict', 'criteria', 'reasons', 'testsPassed'] }

const SEC = { type: 'object', properties: {
  findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, summary: { type: 'string' }, file: { type: 'string' }, scenario: { type: 'string' } }, required: ['severity', 'summary', 'file'] } },
}, required: ['findings'] }

const MODEL = { strong: 'opus', mid: 'sonnet', fast: 'haiku' }

function managerPrompt(team) {
  return `${COMMON}
Your id: ${team.manager} (Manager, ${team.name}). Planning ticket: S${S}-${team.code}-00. Team hub: ${team.hub}.
Your team owns these paths (tickets may only write inside them): ${team.owns.join(', ')}.
Sprint ${S} stories for your team:
${team.stories.map((s, i) => `${i + 1}. ${s}`).join('\n')}
${team.context ? 'Context: ' + team.context : ''}
${(args.deprecated ?? []).length ? `Deprecated agent configurations (ADR-004), never assign them: ${args.deprecated.join(', ')}. Use a successor id (e.g. <role>-v2) with the improved role prompt from org/playbooks/role-prompts.md.\n` : ''}Decompose the stories into ${team.maxTickets ?? 4} or fewer tickets that can ALL run in parallel right now: disjoint paths (no two tickets write the same file or folder), no dependsOn between them. Break dependencies on other teams with the contracts and small local fakes in tests. Size in Fibonacci points (1 pt ≈ one focused file with tests; 8 ≈ a module with API, storage and tests; split anything above 8). Choose tier per ticket: fast for data/boilerplate/docs formatting, mid for most code/design/tests, strong only for architecture or threat modelling. Acceptance criteria must be checkable by a reviewer by reading files and running named tests.
IDs: S${S}-${team.code}-01, -02, ... Owner ids: ic-${team.hub}-<role> using your team's IC roles from org/teams.json. Reviewer: qe-acceptance.
"brief" is the IC's implementation guidance (max ~300 words): what to build, which contract sections, which ctx APIs, test file names, pitfalls. Include everything the IC needs that is not in the linked files.
Create the tickets in the fabric: write a JSON array (each with id, team "${team.id}", title, story, points, tier, owner, reviewer "qe-acceptance", sprint ${S}, status "ready", dependsOn [], paths, contracts, acceptance, brief, valueDrivers, requirements) and pipe it to: AGENT_ID=${team.manager} node org/cli.mjs ticket-new
Then set S${S}-${team.code}-00 to review. Return the same tickets.`
}

function icPrompt(t, team) {
  return `${COMMON}
Your id: ${t.owner} (IC, ${team.name}). Ticket: ${t.id} "${t.title}". Team hub: ${team.hub}.
Paths you may write: ${t.paths.join(', ')}
Contracts: ${(t.contracts ?? []).join(', ') || 'see brief'}
Acceptance criteria:
${t.acceptance.map((a) => '- ' + a).join('\n')}
Brief from your manager:
${t.brief}
Set the ticket in_progress now; when your tests pass set it to review. Return what you built.`
}

function reviewPrompt(t, team, build, round) {
  return `${COMMON}
Your id: qe-acceptance (acceptance reviewer, Quality Engineering). Review ticket ${t.id} "${t.title}" (${team.name}), review round ${round}.
Paths in scope: ${t.paths.join(', ')}
Acceptance criteria:
${t.acceptance.map((a) => '- ' + a).join('\n')}
The IC reported: ${JSON.stringify(build ?? {}).slice(0, 3000)}
Check every criterion against the files and by RUNNING the relevant tests yourself. Also check: tenant isolation respected, no PII in logs/events, contract conformance (shapes match architecture/contracts), only in-scope paths changed (git status shows the whole repo; other teams are writing too, so judge only files plausibly from this ticket), no real-world brands or data. Do not fix the work.
You MUST record the verdict yourself before returning (IMP-7): AGENT_ID=qe-acceptance node org/cli.mjs review ${t.id} <accept|rework> "<one-line reason>"
Regression gate (IMP-4, widened by IMP-13): if the ticket changed anything under src/ (modules, core, ai, web or server.mjs), run the FULL suite (npm test, which includes tests/ui and tests/integration) and compare with the baseline in org/quality-baseline.txt (failures listed there were already failing before this sprint). A NEW failure caused by this ticket's files is grounds for rework. A failure that also occurs on the parent commit is not, but name it in your reasons.
UI gate (IMP-6): if the ticket built UI under src/web/, its Playwright smoke test must exist and pass.
Accept when every criterion is met and tests pass; minor style nits are not grounds for rework.`
}

async function runTicket(t, team) {
  const model = MODEL[t.tier] ?? 'sonnet'
  let build = await agent(icPrompt(t, team), { label: `${t.id} ${t.owner}`, phase: 'Build', model, schema: BUILD })
  let review = await agent(reviewPrompt(t, team, build, 1), { label: `${t.id} review`, phase: 'Review', model: 'sonnet', schema: VERDICT })
  let rounds = 1
  if (review && review.verdict === 'rework') {
    const fix = await agent(`${icPrompt(t, team)}
REWORK requested by the acceptance reviewer. Fix exactly these issues, rerun your tests, set the ticket to review:
${review.reasons}
Unmet criteria: ${JSON.stringify((review.criteria ?? []).filter((c) => !c.met))}`, { label: `${t.id} ${t.owner} rework`, phase: 'Build', model, schema: BUILD })
    build = fix ?? build
    review = await agent(reviewPrompt(t, team, build, 2), { label: `${t.id} review r2`, phase: 'Review', model: 'sonnet', schema: VERDICT })
    rounds = 2
  }
  // IMP-9: security review on every ticket that changes module or core code.
  let security = null
  if (args.securityGate && review?.verdict === 'accept' && t.paths.some((p) => /^src\/(modules|core|ai)\//.test(p))) {
    security = await agent(`${COMMON}
Your id: sec-reviewer (Security, Privacy & Compliance). Security-review ticket ${t.id} "${t.title}" just accepted by QE.
Paths: ${t.paths.join(', ')}. Read architecture/threat-model.md and architecture/security-review-s2.md for the checklist.
Look only at this ticket's files: tenant isolation, RBAC vs openapi x-roles (least privilege), PII in storage/logs/events, injection, DoS (regex, parsers, sizes), SSRF.
Report findings. Severity high or critical only for an exploitable issue with a concrete scenario.`, { label: `${t.id} security`, phase: 'Review', model: 'sonnet', schema: SEC })
    if (security?.findings?.some((f) => f.severity === 'high' || f.severity === 'critical')) {
      const fix = await agent(`${icPrompt(t, team)}
SECURITY REWORK requested. Fix these findings, add a test for each, rerun your tests, set the ticket to review:
${JSON.stringify(security.findings.filter((f) => f.severity === 'high' || f.severity === 'critical'))}`, { label: `${t.id} ${t.owner} security rework`, phase: 'Build', model, schema: BUILD })
      build = fix ?? build
      rounds += 1
    }
  }
  return { id: t.id, team: team.id, points: t.points, security: security?.findings ?? null, tier: t.tier, verdict: review?.verdict ?? 'unknown', rounds, testsPassed: build?.testsPassed ?? false, summary: build?.summary?.slice(0, 600), assumptions: build?.assumptions ?? [], contractChanges: build?.contractChanges ?? [], reviewReasons: review?.reasons }
}

const results = await pipeline(
  args.teams,
  // Pre-planned tickets (orchestrator follow-ups) skip the manager stage.
  (team) => team.tickets ? { tickets: team.tickets } : agent(managerPrompt(team), { label: `S${S}-${team.code}-00 ${team.manager} planning`, phase: 'Plan', model: 'sonnet', schema: TICKETS }),
  (plan, team) => {
    if (!plan || !plan.tickets?.length) { log(`${team.id}: manager returned no tickets`); return [] }
    log(`${team.id}: ${plan.tickets.length} tickets, ${plan.tickets.reduce((a, t) => a + t.points, 0)} pts`)
    return parallel(plan.tickets.map((t) => () => runTicket(t, team)))
  },
)
return results.flat().filter(Boolean)
