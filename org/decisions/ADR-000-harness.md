# ADR-000: Running an agent company inside this harness

Status: accepted · Owner: orchestrator · Date: 2026-10-18

## Context
The program brief asks for 9 teams of a Director, a Manager and 6–10 ICs, with agents messaging each other directly.

## What the harness can and cannot do
- The orchestrator spawns subagents through the Workflow tool (deterministic fan-out) and the Agent tool.
- Subagents **cannot spawn subagents**. Directors and Managers cannot dispatch ICs themselves.
- Each workflow runs at most **2 agents at once** on this 4-CPU container (min(16, CPUs−2)). Several workflows can run side by side.
- Agents share one filesystem and one git checkout. There is no live message bus between running agents.
- No GCP or GitHub credentials are present (`CLOUDSDK_AUTH_ACCESS_TOKEN` is a placeholder; `gh` token rejected). Docker daemon is not running.

## Decision
1. **Logical hierarchy, physical fan-out.** The orchestrator spawns Directors, Managers and ICs as separate agents with role prompts from `org/playbooks/role-prompts.md`. Reporting lines live in `org/teams.json` and on tickets (`owner`, `reviewer`), not in process trees.
2. **Manager decomposition runs as an agent that returns tickets as structured output**; the orchestrator dispatches those tickets to IC agents. This keeps Managers off the critical path, as the brief requires.
3. **Direct signaling through the fabric.** Agents post typed messages to hubs (`node org/cli.mjs post <hub> <type> ...`) and read hubs before starting. Because agents cannot interrupt each other, a question that would block is avoided by contract-first design; any remaining one is posted as `request` and the IC proceeds against the contract and a stub, flagging the assumption.
4. **Disjoint ownership.** Each ticket names the paths it may write. Shared files (`package.json`, `src/server.mjs`) belong to Platform; other teams request changes through the platform hub. This prevents edit collisions without worktrees.
5. **Token accounting** comes from the harness transcripts after each workflow (per-agent usage), written to tickets by the PMO script `org/spend.mjs`.
6. **Concurrency cap**: 6 agents company-wide (3 workflows × 2).
7. **Dev environment** is this container: the platform runs locally with one command. The GCP landing zone in `infra/` stays ready to apply when the sponsor supplies credentials (red flag raised to sponsor).
