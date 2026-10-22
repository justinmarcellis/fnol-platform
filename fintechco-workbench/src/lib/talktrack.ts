export interface TalkTrack {
  scenario: number;
  minutes: string;
  title: string;
  beats: string[];
}

/** ~11 minutes total; the full word-for-word version is DEMO_SCRIPT.md. */
export const TALK_TRACKS: TalkTrack[] = [
  {
    scenario: 1,
    minutes: "3:30",
    title: "SRE & Security: PCI-DSS Log Audit",
    beats: [
      "Open Governance first (10s): \"This CLAUDE.md is checked into the repo. Rule 1 is PCI-DSS 3.4. settings.json denies curl, wget, rm -rf and web access. Claude cannot exfiltrate even if asked.\"",
      "Click Run. Point at the pre-flight line: \"The gate is RED before Claude touches anything: 4 of 4 tests failing. A raw card number is reaching our logs.\"",
      "As grep lines stream: \"It found the leak in Python and in the Go health check. Two languages, one policy. That's your 20 SREs working in Go, Python and shell.\"",
      "Diff panel: \"Surgical: a last-4 mask and structured JSON logs. It didn't touch the tests; Rule 4 forbids it.\"",
      "Scorecard: \"PAN leak sites: 3 → 0. Incident triage target is −50%, 42 to 21 minutes MTTR, because every log line is now machine-parsable.\"",
      "Bridge: \"That's governance. Now velocity, the 160 people who ship features.\"",
    ],
  },
  {
    scenario: 2,
    minutes: "3:45",
    title: "Data Science → SWE: Notebook to Typed API",
    beats: [
      "Set up the pain (30s): \"Today a DS hands a notebook to an SWE and it takes weeks. Untyped, scores above 1.0, nobody owns the contract.\"",
      "Click Run. Call out the real execution: \"Claude ran the notebook function: 1.44. A probability above 1. That bug would ship today.\"",
      "Diff: \"Typed dataclass, TypedDict contract, bounded score, explicit APPROVE/REVIEW/DECLINE thresholds, input validation, a FastAPI route, and the TypeScript contract for the checkout team.\"",
      "Contract Tester: click Send. \"This is executing the module Claude just wrote, live. Change the amount to $25 and it approves.\" Let the CTO pick a number.",
      "Impact: \"Notebook-to-API goes from weeks to hours; target −35% lead time across 40 DS and 120 SWEs. The DORA number we'd measure in the pilot.\"",
    ],
  },
  {
    scenario: 3,
    minutes: "3:30",
    title: "Quants & Executives: FRED Stress Test",
    beats: [
      "Frame: \"Claude Code isn't only for engineers. Your quant team owes the Board a rate-sensitivity brief by Friday.\"",
      "Click Run. \"Rule 5 says standard library only, reproducible from the checked-in CSV. It wrote the Pearson test and p-value from scratch, and the test suite verifies the math.\"",
      "Chart: hover the 2022 hiking cycle. \"Delinquency follows the rate with a lag. The correlation is computed, not typed in.\"",
      "Read the three Board bullets aloud. \"The stress case is a number the CRO can act on.\"",
      "Close: \"Three teams, one governed platform, a few cents per run. Header shows the cost. Against a $32.4M payroll, 12% velocity is $3.8M a year.\" Then click ROI Calculator (top right) to open fintechco-roi.web.app and model it live.",
    ],
  },
];

export interface Objection {
  topic: string;
  question: string;
  answer: string;
}

export const OBJECTIONS: Objection[] = [
  {
    topic: "Security",
    question: "\"Our code and card data can't leave our cloud.\"",
    answer:
      "Claude runs through your own Vertex AI or Bedrock tenancy, inside your IAM, VPC-SC and audit logging, under zero data retention. Your code is not used for training. CLAUDE.md and managed settings.json enforce the tool allowlist on every workstation and CI runner, and the deny rules (curl, wget, web fetch) are enforced by the client, not by prompt.",
  },
  {
    topic: "Copilot / Cursor",
    question: "\"We already pay for Copilot. Why another tool?\"",
    answer:
      "Autocomplete predicts the next line in one file. Claude Code is an agent: it reads the repo, runs the tests, and iterates until the gate is green, as you just saw. It's terminal-native, so the same agent runs headless in CI (claude -p) and works for SREs and data scientists who don't live in an IDE. Keep Copilot for completion; this covers the work completion can't.",
  },
  {
    topic: "Token cost",
    question: "\"How do we stop costs running away?\"",
    answer:
      "Each run in this demo cost cents, and the header shows it per run. Controls: per-user and per-team spend limits on the Vertex / Bedrock billing account, --max-turns and model selection in managed settings, prompt caching for repeated repository context, and OpenTelemetry cost metrics into your existing dashboards. Even 10× this usage is a rounding error against $3.8M of recaptured capacity.",
  },
  {
    topic: "Adoption",
    question: "\"How do we avoid shelfware?\"",
    answer:
      "Start with 25 champions (15 SWE, 5 DS, 5 SRE) and baseline DORA metrics in week 1. Ship a shared CLAUDE.md and slash commands for your top 5 workflows so day one is useful. Report lead time and MTTR weekly against the baseline. Expand to 180 only when the pilot hits its numbers, so the roll-out decision rests on your data.",
  },
];
