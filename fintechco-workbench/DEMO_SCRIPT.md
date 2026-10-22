# FinTechCo Workbench: Presenter Script

About 11 minutes in total, roughly 3½ minutes per scenario. Each run plays out on screen in about 15 seconds, and the script fills the rest.
**Before you start:** open https://fintechco-workbench.web.app and click **Reset Workspace**.

---

## Moving from the slides (15 seconds)

> "Everything on that last slide was a claim. Let me show you three of them actually running. Each button gives Claude Code a real task, with real code and real checks, in a cloud environment like the one you'd use."

---

## Scenario 1: Find and fix leaked card numbers (3½ minutes)

**Show the rules (about 45 seconds).** Click **Governance**. It opens on **Our rules**.
> "Before Claude touches anything, this is what it has to follow. These rules live alongside your code and get reviewed like code. Rule 1: never write a full card number to a log."

Click **Permissions**.
> "This is the hard boundary. Green is what Claude may do: read, edit, run our checks. Red is blocked: sending data out, deleting things, browsing the web. The software enforces it, so even if someone asked Claude to send data somewhere, it couldn't."

Close the window.

**Run it (about 20 seconds).** Click **Run** on card 1.
- When **"0 of 4 checks pass today"** appears:
  > "The first thing it does is run our checks, and they fail. A full card number is reaching our logs right now."
- When the **[found]** lines appear:
  > "It found the problem in two systems written in two different languages. One rule, applied everywhere."
- When **"4 of 4 checks passed"** appears:
  > "Fixed and proven. And it didn't change the checks to get there; our rules forbid that."

**Walk through the results (about 2 minutes).**
- **What changed (top right):**
  > "This is exactly what Claude changed. Red lines were removed, green lines were added. It's a small fix a reviewer can read in a minute."
- **Copy summary for reviewers:**
  > "One click gives the reviewer a ready-made summary: what changed and how we know it works."
- **Security scorecard (bottom right):**
  > "Three leaks down to zero, proven by tests." Point at the log line: "The top line is a compliance finding. The bottom line is safe, and it's searchable."
  > "That last part matters for incidents. When logs are consistent, the team, and Claude, can find the cause faster. We expect incidents to be resolved in half the time."

**Bridge.**
> "That's the safety side. Now speed, for the 160 people who build the product."

---

## Scenario 2: Turn a fraud model into a production service (3½ minutes)

**Set it up (about 40 seconds).**
> "Every fintech knows this handoff. A data scientist builds a fraud model as an experiment. Then an engineer spends two or three weeks rebuilding it into something production can rely on, and the model goes stale while they wait."

**Run it (about 20 seconds).** Click **Run** on card 2.
- When **"fraud score 1.44"** appears:
  > "Look at this. It tested the current model first, and the fraud probability came back as 1.44. A probability can't be above 1. Today, that ships."
- When the **[thinking]** lines appear:
  > "Now it's planning the fix against our rules: a score that stays between 0 and 1, and a clear decision for every payment."
- When **"4 of 4 checks passed"** appears: "All checks pass."

**Walk through the results (about 2¼ minutes).**
- **What changed:**
  > "The score is now kept between 0 and 1, every payment gets approve, review or decline, and bad inputs are rejected." Click the second file tab: "It also wrote a shared definition, so every team calls this service the same way."
- **Try the fraud check (the main moment):** click **Check this payment ($4,500)**.
  > "This is the service Claude just built, running live, not a mock-up. A $4,500 payment from overseas, the eighth purchase today: declined, in well under a millisecond."
  Click **$25 coffee**, then **Check this payment**.
  > "A $25 coffee: approved." *(Optional: ask the CTO to type in an amount.)*
- **Impact tiles:**
  > "Experiment to production goes from weeks to hours. Across 40 data scientists and 120 engineers, that's our target of shipping changes 35% faster, and it's what we'd measure in the pilot."

**Bridge.**
> "Last one, and it isn't for engineers at all."

---

## Scenario 3: Review every pull request before a person does (3½ minutes)

**Set it up (about 40 seconds).**
> "Here's where engineering time actually goes. Every change waits for a senior engineer to review it, often for a day or more. Reviewers are busy and tired, so things slip through. That's the bottleneck behind the 35% on the KPI slide."

**Run it (about 15 seconds).** Click **Run** on card 3.
- When **"0 of 4 checks pass today"** appears:
  > "This is a realistic pull request: a new feature that lets support agents issue refunds. It fails our checks before anyone has looked at it."
- When the **[found]** lines appear:
  > "In seconds it found two serious problems. Someone could type a specially crafted order number and refund every order. And there's a live payments key sitting in the code."
- When the **[thinking]** lines appear:
  > "It also noticed that anyone signed in could issue refunds, and nothing stops a refund bigger than the payment."
- When **"4 of 4 checks passed"** appears: "All four fixed, and proven."

**Walk through the results (about 2¼ minutes).**
- **Pull request review (bottom right):**
  > "Blocked, now ready for human review. Four findings, two of them critical, each with the line, the problem and the fix, in plain English."
- **What changed (top right):** click the **REVIEW.md** tab.
  > "These are the notes it leaves for the human reviewer. It also tells the reviewer what's still their call: confirm the role name, and rotate the exposed key, because it's still in the history. Claude doesn't approve its own work. A person merges."
  Click **refund_service.py**: "And here's the fix itself. It's small, and a reviewer can read it in a minute."
- **Impact tiles:**
  > "In practice this runs automatically on every pull request, inside the code review tools your team already uses. Senior engineers stop being the first line of defense and review a clean change instead of a first draft. That's how you get changes shipped 35% faster, and it's the first thing we'd measure in the pilot."

**Close the demo.**
> "Three teams, one set of rules. Security got a proven fix, data science got a production service, and every engineer gets a reviewer that never sleeps. Each run cost a few cents." Click **ROI Calculator ↗**: "Now let's put your numbers into it. This is where the $3.8 million comes from."

---

## If something goes wrong
- **A run looks wrong:** click **Reset Workspace** and run it again. Every run starts from a clean copy.
- **Someone asks "Is that a live model?":** "This version replays a reviewed run so the demo is the same every time. The checks, the code changes and the numbers you saw were all computed live just now. In the pilot, Claude works live inside your own Google Cloud account."
- **Your notes:** press `?` to open or close the presenter notes. The audience never sees them unless you open them.
- **Want more on the setup?** Click **How it fits together** in the top bar for a one-page overview of the setup.
