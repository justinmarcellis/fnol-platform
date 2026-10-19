# Test strategy (v1)

Owner: Quality Engineering (`quality` hub). Applies to every ticket in `org/board/tickets/`. Standards live in [org/playbooks/standards.md](../org/playbooks/standards.md); module shape in [ADR-001](../org/decisions/ADR-001-stack-and-layout.md) and [architecture/contracts/modules.md](../architecture/contracts/modules.md). Requirements are `REQ-01..REQ-25` in [product/requirements.md](../product/requirements.md). This document links those sources and does not restate them.

Runner for everything: `node --test --disable-warning=ExperimentalWarning <paths>` (no test dependency; `node:test` and `node:assert` only). Repo scripts: `npm test`, `npm run test:unit`, `npm run test:e2e` (see `package.json`).

## 1. Test pyramid

| Layer | Owner | Location | Scope | Ratio (tests) | Gate |
|---|---|---|---|---|---|
| Unit | Module author (IC) | `tests/unit/<module>/*.test.mjs`, core in `tests/unit/core/` | One module or core file; fakes for other modules; `:memory:` store via `tests/unit/core/helpers.mjs` | ~70% | Must pass before a ticket moves to `review` |
| Integration | Module pair owners, reviewed by QE | `tests/integration/<context>/*.test.mjs` | One bounded context or module pair (for example intake + coverage) over a real bus and `ctx.forTenant(tenantId)` | ~15% | Must pass before sprint close |
| Security | QE | `tests/security/*.test.mjs` | Tenant isolation (REQ-18), authorization by role (REQ-19), PII encryption and log redaction (REQ-20), injection and malformed input on API inputs, audit presence (REQ-21) | ~8% | Zero failures; any failure is an S1 or S2 defect |
| E2E | QE | `tests/e2e/*.test.mjs` | Full HTTP flow per line of business, driven by `SCENARIOS` in `tests/synthetic`: `auto`, `home`, `commercial auto` | ~7% | Must pass before demo; one scenario per LOB per demo tenant |

Rules:
- Higher layers never re-test what a lower layer covers. Add the cheapest test that can fail for the defect.
- Tests are deterministic: inject `ctx.clock`, seed generators, use the `local` AI provider. No network, no wall-clock sleeps.
- A test for a not-yet-built module is `t.todo('REQ-xx: ...')`, never a skipped or commented test (see section 4).
- Run only the paths you own while others are mid-flight, for example `node --test --disable-warning=ExperimentalWarning tests/unit/core/store.test.mjs`. CI runs the whole suite.

## 2. Synthetic-data rule

Every record in a test, seed or fixture is generated, seeded and fictional.
- No real carrier names, people, logos, addresses, plates or policy numbers. Demo tenants are the fictional Aurelia Mutual and Kestrel Point Insurance (see REQ-22).
- Use `generatePolicies(seed, n)` and `generateScenario(seed, lob)` from `tests/synthetic` (names from the ticket that ships them). The same seed must give byte-identical output; assert this once in that module's unit test. Never call `Math.random()` or `Date.now()` in fixtures; use the seed and `ctx.clock`.
- VINs must be 17 characters with a valid check digit (position 9) and no I, O or Q. Plates are PII (standards.md) and are synthetic and stored through `ctx.crypto.encryptPii`.
- Names, phones and emails use reserved fictional forms: phone `555-01xx`, email domain `example.test`.
- No secrets in git; credentials come from `.secrets/` (gitignored). Tests run on the `local` AI provider and must pass with no credentials.
- Review check: grep new fixtures for any name not produced by the generators.

## 3. Acceptance against REQ-xx

Every story and ticket acceptance criterion cites at least one REQ id, and every REQ with priority M has at least one test at e2e or integration level. QE maintains the matrix below (extend the table; one row per REQ, statuses `pass`, `fail`, `todo`, `none`).

| REQ | Layer | Test file | Status |
|---|---|---|---|
| REQ-18 Tenant isolation | security | `tests/security/tenant-isolation.test.mjs` | todo |
| REQ-20 PII encryption | unit | `tests/unit/core/crypto.test.mjs` | pass |
| REQ-21 Audit trail | unit | `tests/unit/core/audit.test.mjs` | pass |
| REQ-01 Omnichannel intake | e2e | `tests/e2e/auto-intake.test.mjs` | todo |
| REQ-xx | layer | path | status |

Test names start with the id, for example `test('REQ-18: tenant B cannot read tenant A claim', ...)`, so a grep for `REQ-18` lists the evidence. The Given/When/Then in `product/requirements.md` is the oracle; do not weaken an assertion to make a test pass.

## 4. CI reporting to org/quality.json

`org/quality.json` does not exist yet and no scorecard exists in `org/scorecards/`. Proposal below; the CI script (`scripts/`, platform team) writes it, not test authors. `org/config.json` already targets `testPassRate: 1.0`, which this file feeds.

```json
{
  "generatedAt": "2026-10-18T21:00:00.000Z",
  "commit": "abc1234",
  "layers": {
    "unit":        { "pass": 112, "fail": 0, "todo": 9, "durationMs": 4100 },
    "integration": { "pass": 18,  "fail": 0, "todo": 4, "durationMs": 6200 },
    "security":    { "pass": 10,  "fail": 0, "todo": 2, "durationMs": 2300 },
    "e2e":         { "pass": 3,   "fail": 0, "todo": 3, "durationMs": 9800 }
  },
  "totals": { "pass": 143, "fail": 0, "todo": 18, "passRate": 1.0 },
  "reqCoverage": { "total": 25, "withPassingTest": 6, "withTodoOnly": 12, "none": 7 },
  "defects": { "open": { "S1": 0, "S2": 0, "S3": 1, "S4": 0 }, "escapes": 1, "escapeRate": 0.05 }
}
```

- Source: `node --test --test-reporter=spec` per layer directory (or `--test-reporter=tap`); count lines `ok`, `not ok` and `# TODO`.
- `passRate = pass / (pass + fail)`; todo is excluded from the denominator and reported separately, so missing modules never inflate or hide the rate.
- `t.todo` semantics: a todo test is a declared, named gap for a module that does not exist yet (`test.todo('REQ-09: subrogation flag set on third-party fault')`). It does not fail the build. When the module ships, the same ticket converts todo to a real test. A todo with no REQ id in its name is rejected in review. Skipped tests (`skip`) are not allowed.
- Gate: `fail > 0` anywhere blocks acceptance; `reqCoverage.none` for any M requirement blocks the sprint review.
- Additive changes only: consumers (dashboard under `dashboard/`) must ignore unknown keys.

## 5. Defect classification and escapes

Every defect has a severity, a type and a found-in phase.

| Severity | Meaning |
|---|---|
| S1 | Data leak across tenants, PII in clear or logs, claim lost or corrupted, platform will not start |
| S2 | Core flow blocked (cannot file, route or view a claim), contract break with no workaround, authorization bypass limited to one tenant |
| S3 | Feature wrong with a workaround, wrong explanation or label, non-blocking error handling gap |
| S4 | Cosmetic, copy, minor documentation |

Types: `functional`, `contract` (differs from `architecture/contracts/`), `security`, `data`, `perf`.
Found-in phase: `unit`, `integration`, `security`, `e2e`, `review` (acceptance review), `post-accept` (found after the ticket was accepted).

An escape is a defect found after its originating ticket was accepted (`done`). It is recorded as an entry in the `review.escapedDefects` array on the originating ticket file in `org/board/tickets/`, and also posted: `AGENT_ID=<id> node org/cli.mjs post quality defect "<text>" --ticket <ID>`.

Entry shape and worked example, appended to `org/board/tickets/S1-EXAMPLE-01.json` (a fictional ticket "claim lookup by plate"):

```json
{
  "review": {
    "verdict": "accept",
    "escapedDefects": [
      {
        "id": "DEF-001",
        "severity": "S1",
        "type": "security",
        "foundIn": "e2e",
        "foundAt": "2026-10-20T09:15:00.000Z",
        "summary": "Lookup by plate on tenant Kestrel Point returned a claim owned by Aurelia Mutual",
        "req": "REQ-18",
        "rootCause": "Query used the raw db handle instead of ctx.forTenant(tenantId)",
        "regressionTest": "tests/security/tenant-isolation.test.mjs",
        "fixedBy": "S1-EXAMPLE-02",
        "status": "fixed"
      }
    ]
  }
}
```

Rules:
- Every escape gets a regression test, named with the defect id (`test('DEF-001: ...')`), landing in the same ticket as the fix. The fix is not accepted without it.
- Escape rate = escapes found in a sprint / tickets accepted in that sprint, reported in `org/quality.json` under `defects`. Target 0 for S1 and S2; any S1 or S2 escape triggers a root-cause note in the quality hub and a check of the sibling modules for the same pattern.
- Defects found before acceptance (phase `unit` through `review`) are not escapes; fix them in the ticket and do not record them.
