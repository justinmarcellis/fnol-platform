# FinTechCo Workbench: Presenter Script

About 11 minutes in total, roughly 3½ minutes per scenario. Each run takes about 15 seconds to play out on screen, and the script fills the rest.
**Before you start:** open https://fintechco-workbench.web.app and click **Reset Workspace**.

---

## Transition from the deck (0:15)

> "Everything on the last slide was a claim. Let me show you three of them running. This is a live workbench on Google Cloud Run. Each button runs Claude Code headless, the same `claude -p` your CI pipeline would call, against a real workspace with real tests."

---

## Scenario 1: SRE & Security, PCI-DSS Log Audit (3:30)

**0:00 Set up the governance (≈45s).** Click **Governance**, stay on the CLAUDE.md tab.
> "Before Claude touches any code, this is what it's bound by. This CLAUDE.md lives in your repo, under version control and code review. Rule 1 is PCI-DSS 3.4: never log a full card number."

Click the **.claude/settings.json** tab.
> "This is the hard boundary. Green is allowed: read, edit, run pytest. Red is denied: curl, wget, rm -rf, web fetch. The client enforces this, not the prompt. Even if someone asked Claude to send data out, it can't. And the env block routes every call through *your* Vertex AI project."

Close the modal.

**0:45 Run it (≈20s).** Click **Run Claude Code** on card 1.
- When **[FAILED] Baseline: 0/4** appears:
  > "First thing it does is run the compliance gate. It's red: four of four tests failing. A raw 16-digit card number is reaching our logs today."
- When the **[tool:Grep]** lines appear:
  > "It found the leak in the Python payment worker and in the Go health check. Two languages, one policy. That's how your 20 SREs actually work: Go, Python and shell."
- When **[PASSED] 4/4** appears:
  > "Gate is green. Notice it never touched the test file. Rule 4 forbids it."

**1:20 Walk the results (≈2:00).**
- **Diff panel (top right):**
  > "Here's exactly what changed. Red is gone, green is new. A last-four mask, and the log line is now structured JSON. A small, reviewable diff, not a rewrite." Click the **sre_log_check.go** tab: "Same fix in Go, using slog."
- **Copy PR Summary:**
  > "One click gives your reviewer a compliance-ready PR description: files, test result, rules applied."
- **Scorecard (bottom right):**
  > "Three leak sites down to zero, verified by tests. Point at the before/after log line. That top line is a PCI finding. The bottom line is safe *and* machine-parsable."
  > "That second part is where MTTR comes from. Structured logs mean triage is a query, not a grep. We'd target 42 minutes down to 21: the −50% on the KPI slide."

**3:20 Bridge.**
> "That's governance. Now velocity: the 160 people who ship product."

---

## Scenario 2: Data Science → SWE, Notebook to Production API (3:45)

**0:00 Set up the pain (≈40s).**
> "Here's a handoff every fintech has. A data scientist builds a fraud model in a notebook. It's untyped, the coefficients were copied by hand, and an engineer spends two or three weeks turning it into a service. During that time the model is going stale."

**0:40 Run it (≈20s).** Click **Run Claude Code** on card 2.
- When **evaluate_transaction_risk(4500, 8, True) → 1.44** appears:
  > "Look at this. It actually ran the notebook function, and the fraud *probability* came back as 1.44. That's above 100%. Today that bug ships, or it costs a week of back-and-forth."
- When the **[reasoning]** lines appear:
  > "It's planning against CLAUDE.md Rule 2: typed schema, a score bounded between zero and one, explicit decisions."
- When **[PASSED] 4/4** appears: "Gate's green."

**1:15 Walk the results (≈2:15).**
- **Diff panel:**
  > "Typed dataclass, a TypedDict contract, input validation that rejects a negative amount, APPROVE/REVIEW/DECLINE thresholds, and a FastAPI route." Click the **fraud_api_contract.ts** tab: "And the TypeScript contract for your checkout team. The Java team generates from the same OpenAPI spec. One contract across Python, TypeScript and Java."
- **Contract Tester (the main moment):** click **Send Test Transaction ($4,500)**.
  > "This is calling the module Claude just wrote. It's live, not a mock. A $4,500 foreign transaction with eight hits in 24 hours: DECLINE, schema valid, scored in a fraction of a millisecond."
  Click **$25 coffee · domestic**, then **Send**.
  > "Twenty-five-dollar coffee: APPROVE." *(Optional: invite the CTO to pick a number and type it into amount.)*
- **KPI tiles:**
  > "Notebook-to-API goes from weeks to hours. Across 40 data scientists and 120 engineers, that's the −35% lead time on the KPI slide, and it's the DORA number we'd measure in the pilot."

**3:35 Bridge.**
> "Last one, and it's not for engineers at all."

---

## Scenario 3: Quants & Execs, Federal Reserve Stress Test (3:30)

**0:00 Set up (≈35s).**
> "Your CRO owes the Board Risk Committee a rate-sensitivity brief by Friday. Normally a quant spends two days in a notebook. Policy says it has to be reproducible: standard library only, computed from the checked-in data."

**0:35 Run it (≈15s).** Click **Run Claude Code** on card 3.
- When **Read fred_macro_data.csv (25 quarters…)** appears:
  > "Six years of Fed Funds data from FRED against our delinquency rate, quarterly."
- When the **[reasoning]** lines appear:
  > "No numpy, no scipy. It's writing the Pearson correlation and the p-value from first principles, and the test suite checks the math."
- When **r = 0.91 · p < 0.001** appears:
  > "There's the answer: strong and statistically significant."

**1:05 Walk the results (≈2:10).**
- **Chart:** hover across 2022 into 2023.
  > "Orange is the Fed Funds rate, blue is our delinquency. Watch the 2022 hiking cycle. Delinquency follows it up with a short lag. The correlation is computed live from the CSV, not typed into a slide."
  Hover 2020-Q2: "And here's the COVID spike. Unemployment at 13%, delinquency up even at zero rates. Credit risk isn't only about rates, and the model doesn't pretend it is."
- **Board bullets:**
  > "And these are the three bullets for the Board, generated from the computed numbers." Read the third bullet aloud: "A +200 basis point shock implies about 2.8% delinquency. That's a number a CRO can act on."
- **Diff (optional, 15s):** "Behind it, about 90 lines of tested, reviewable Python, not a black-box spreadsheet."

**3:15 Close the demo.**
> "Three teams, one governed platform. Security got a verified PCI fix, engineering got a production API, the Board got a stress test. Each run cost a few cents in tokens." Click **ROI Calculator ↗**: "Now let's put your numbers on it. This is where the $3.8M comes from."

---

## If something goes wrong
- **Any run looks off:** click **Reset Workspace** and run it again. Each run starts from a clean copy of the files.
- **Asked "is that a live model?":** "This deployment runs in deterministic mode so the demo is repeatable. The tests, diffs and statistics you saw executed for real on Cloud Run. In the pilot it runs live against your Vertex AI project, through the same pipeline."
- **Presenter notes on screen:** press `?` to open or close them. They aren't visible to the audience otherwise.
