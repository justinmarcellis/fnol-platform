# ADR-004: Stack rank and deprecation of agent configurations

Status: accepted · Owner: dir-pmo · Date: 2026-10-19

## Decision
An "agent configuration" is an owner id plus its model tier, for example `ic-experience-csr-portal-dev` (mid). Agents are spawned per ticket, so what is ranked, intervened on and deprecated is the configuration: its role prompt, its tier and the kind of ticket it receives.

1. **Rank.** At every sprint close, `node org/scorecards.mjs` scores each configuration: 0.35 × first-pass acceptance, 0.20 × (1 − rework), 0.20 × estimate accuracy, 0.15 × cost efficiency, 0.10 × (1 − escaped defects). `org/live-export.mjs` publishes the stack rank to the live board.
2. **Confidence.** A configuration with fewer than 3 tickets is low confidence. It is shown but never acted on.
3. **Flag.** A configuration is flagged when it is in the bottom 10% by composite, or below the first-pass target for two sprints in a row.
4. **Diagnose before acting.** Classify the cause: unclear ticket, oversized task, missing context, wrong tier, weak role prompt, bad dependency, or capability limit. Record it in `org/scorecards/interventions.json`.
5. **Intervene in order:** fix the ticket or context → resize → adjust the role prompt → change tier → pair with a top-ranked configuration's approach → reassign the work type.
6. **Deprecate.** If a flagged configuration is still in the bottom 10% two sprints after its last intervention, the orchestrator adds it to `org/scorecards/deprecations.json` with the reason and its successor id. The sprint workflow passes that list to every Manager, and Managers may not assign deprecated ids.
7. **Successor.** The successor configuration (`<role>-v2`) starts with a fresh scorecard, the improved role prompt and, where diagnosed, a different tier. Its results are compared with the deprecated configuration's in the improvement log.

## Status at adoption
No configuration met the deprecation rule. Two were flagged and are on watch with context interventions: PI-1 (`ic-experience-csr-portal-dev`) and PI-2 (`ic-quality-e2e-engineer`).
