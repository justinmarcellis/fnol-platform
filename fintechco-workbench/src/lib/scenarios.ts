// Client-safe scenario metadata and the stream event contract shared by the
// /api/run-scenario route and the workbench UI.

export type ScenarioId = 1 | 2 | 3;
export type Mode = "live" | "safe";

export interface Scenario {
  id: ScenarioId;
  team: string;
  title: string;
  details: string;
  /** Files Claude Code is expected to change; the diff viewer shows these. */
  targets: string[];
  testFile: string;
  /** The request as a person would say it; shown in the terminal. */
  ask: string;
  prompt: string;
  /** Estimated tokens / cost shown in Safe Mode, where no API call is made. */
  estTokens: number;
}

const GUARDRAIL =
  "Follow CLAUDE.md. Do not modify any test_*.py file. Finish only when the gate passes.";

export const SCENARIOS: Scenario[] = [
  {
    id: 1,
    team: "1 · Security & reliability team",
    title: "Find and fix leaked card numbers",
    details:
      "Claude checks the payment systems against our security rules, hides any full card numbers in the logs, and proves the fix with automated tests.",
    targets: ["sre_payment_worker.py", "sre_log_check.go"],
    testFile: "test_pci_compliance.py",
    ask: "Check our payment logs for full card numbers, hide them, and prove the fix with tests",
    prompt: `Audit sre_payment_worker.py and sre_log_check.go against CLAUDE.md Rules 1 and 3. Mask every raw PAN as XXXX-XXXX-XXXX-1234 (last 4 visible) and emit structured JSON logs in both files. Run python3 -m pytest test_pci_compliance.py -q. ${GUARDRAIL}`,
    estTokens: 2840,
  },
  {
    id: 2,
    team: "2 · Data science and engineering",
    title: "Turn a fraud model into a production service",
    details:
      "Claude turns a data scientist's rough fraud-scoring experiment into a reliable service other teams can call, then tests it.",
    targets: ["ds_fraud_notebook.py", "fraud_api_contract.ts"],
    testFile: "test_fraud_api.py",
    ask: "Turn this fraud-scoring experiment into a reliable service other teams can use, and test it",
    prompt: `Promote ds_fraud_notebook.py to production per CLAUDE.md Rule 2: strict type hints, a dataclass/TypedDict schema, a risk_score bounded to [0.0, 1.0], APPROVE/REVIEW/DECLINE decisions, ValueError on invalid input, and a FastAPI POST /v1/payments/score endpoint. Also write fraud_api_contract.ts with the matching TypeScript request/response types. Run python3 -m pytest test_fraud_api.py -q. ${GUARDRAIL}`,
    estTokens: 3910,
  },
  {
    id: 3,
    team: "3 · Every engineering team",
    title: "Review every pull request before a person does",
    details:
      "Claude reviews a new refund feature like a senior engineer, finds the security problems, fixes them, and leaves clear notes for the human reviewer.",
    targets: ["refund_service.py", "REVIEW.md"],
    testFile: "test_refund_service.py",
    ask: "Review this pull request for security and correctness, fix what's blocking, and leave notes for the reviewer",
    prompt: `refund_service.py is pull request #1427. Review it for security and correctness against CLAUDE.md. Fix every blocking issue in refund_service.py, then write REVIEW.md for the human reviewer: a table of each finding with severity, line, what was wrong and what changed, in plain English, plus anything the reviewer must still check. Run python3 -m pytest test_refund_service.py -q. ${GUARDRAIL}`,
    estTokens: 3620,
  },
];

export function getScenario(id: number): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** Blended Sonnet-class price per token used for Safe Mode estimates. */
export const EST_USD_PER_TOKEN = 0.000012;

export function buildCliArgs(s: Scenario): string[] {
  return [
    "-p",
    s.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--max-turns",
    "8",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Read,Edit,Write,Glob,Grep,Bash(python3 -m pytest*),Bash(pytest*)",
    "--disallowedTools",
    "Bash(curl*),Bash(wget*),Bash(rm*),WebFetch,WebSearch",
  ];
}

export function displayCommand(s: Scenario): string {
  return `$ claude "${s.ask}"`;
}

export interface FileDiff {
  path: string;
  before: string;
  after: string;
}

export interface PytestSummary {
  passed: number;
  failed: number;
  total: number;
  ok: boolean;
  output: string;
  /** True when python3/pytest was unavailable and cached output was shown. */
  cached: boolean;
  /** Pass or fail for each check, keyed by test function name. Empty when results were cached. */
  checks: Record<string, "pass" | "fail">;
}

export type LogTag =
  | "cmd"
  | "init"
  | "read"
  | "grep"
  | "reasoning"
  | "edit"
  | "bash"
  | "out"
  | "pass"
  | "fail"
  | "guard"
  | "hook"
  | "done";

export type StreamEvent =
  | { type: "log"; tag: LogTag; text: string }
  | { type: "mode"; mode: Mode; reason: string }
  | {
      type: "result";
      scenarioId: ScenarioId;
      mode: Mode;
      files: FileDiff[];
      /** The checks as they stood before Claude changed anything. */
      baseline: PytestSummary;
      pytest: PytestSummary;
      metrics: { durationMs: number; tokens: number; costUsd: number; estimated: boolean };
    }
  | { type: "error"; message: string };
