import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";

export const metadata: Metadata = {
  title: "Agent Lifecycle",
  description: "How to build, teach, test and grow AI agents safely, and what software delivery looks like with agents.",
};

const ADLC = [
  { step: "Choose the job", what: "Pick one task that is frequent, well understood, and already has a clear definition of \"done\", such as fixing a failing test or reviewing a pull request." },
  { step: "Write down how we work", what: "Give the agent the same briefing a new hire would get: team rules, conventions, and where things live. This goes in plain text files that sit next to the code." },
  { step: "Set the boundaries", what: "Decide what the agent may and may not do, and enforce it with permissions, hooks and a sandbox, so safety doesn't depend on the agent remembering." },
  { step: "Build the test set", what: "Collect 20 to 50 real past examples of the job, each with a known good result. This is how you'll know whether the agent is good enough, and whether changes make it better or worse." },
  { step: "Pilot with people in the loop", what: "Let a small group use it while a person reviews every change. Every correction they make is a lesson to write back into the files." },
  { step: "Measure and improve", what: "Track how often it gets the job right the first time, how much people had to fix, what the guardrails blocked, and what it cost. Re-run the test set after every change." },
  { step: "Expand when the numbers say so", what: "Give the agent more responsibility only when it consistently meets the bar you set in advance, never on enthusiasm alone." },
];

const SDLC = [
  { phase: "Plan", agent: "Turns a request into a written plan: what will change, what could break, how it will be tested.", human: "Agrees the plan before any code is written.", feature: "Plan mode" },
  { phase: "Design", agent: "Checks the plan against the team's architecture patterns and flags anything that doesn't fit.", human: "Makes the design calls the agent shouldn't.", feature: "Skills, CLAUDE.md" },
  { phase: "Build", agent: "Writes the change, following the team's rules. Larger jobs are split between specialized helper agents.", human: "Stays available for questions and decisions.", feature: "Subagents" },
  { phase: "Test", agent: "Writes the tests, runs them, and keeps fixing until they pass. A hook stops it from declaring \"done\" early.", human: "Checks the tests actually test the right thing.", feature: "Hooks" },
  { phase: "Review", agent: "Reviews every pull request automatically before a person looks, and leaves plain-English notes.", human: "Approves or rejects. A person always makes the final call.", feature: "Automated code review in CI" },
  { phase: "Release", agent: "Prepares release notes, checks the deployment steps, and watches the first minutes after release.", human: "Decides when to release.", feature: "Headless runs in pipelines" },
  { phase: "Operate", agent: "Reads logs and alerts during an incident, finds likely causes, and drafts a fix.", human: "Leads the incident and approves any change.", feature: "Connections to monitoring tools" },
];

const LEVELS = [
  { level: "1 · Assist", who: "A person drives; the agent suggests and explains.", unlock: "Start here. No access to production, and every change is made by a person.", gate: "People find it useful in daily work." },
  { level: "2 · Supervised", who: "The agent does the task; a person reviews every change before it's kept.", unlock: "Edits allowed in a working copy. Tests and hooks required.", gate: "About 80% of tasks accepted with small or no edits, and zero guardrail breaches." },
  { level: "3 · Delegated", who: "The agent runs on its own for a defined task, such as reviewing every pull request; people review the results.", unlock: "Runs automatically in the delivery pipeline, with a narrow set of permissions.", gate: "Test-set success holds steady over several weeks, and people rarely overturn its work." },
  { level: "4 · Trusted", who: "The agent handles routine, low-risk work end to end, within strict guardrails, and reports what it did.", unlock: "Scheduled or event-driven runs, still behind hooks, sandbox and audit logs.", gate: "Reviewed regularly; any drop in results moves it back a level." },
];

const FILES = [
  { file: "CLAUDE.md", plain: "The briefing document", does: "Team rules, conventions and context that Claude reads at the start of every session. Version-controlled and reviewed like code.", start: true },
  { file: ".claude/settings.json", plain: "The rulebook the software enforces", does: "Permissions (allowed and blocked actions), hooks, sandbox settings and environment. Shared with the whole team through the repository.", start: true },
  { file: "Managed settings", plain: "The company-wide policy", does: "The same settings deployed by IT to every machine. Individual users and projects can't override them.", start: false },
  { file: ".claude/skills/<name>/SKILL.md", plain: "A how-to guide", does: "Reusable know-how, such as the team's architecture patterns or a review checklist. Claude loads it when it's relevant to the task.", start: false },
  { file: ".claude/commands/<name>.md", plain: "A saved request", does: "A prompt the team runs by name, such as /review-pr, so everyone asks for the same thing the same way.", start: true },
  { file: ".claude/agents/<name>.md", plain: "A specialist helper", does: "A focused helper agent with its own instructions and a narrower set of tools, such as a security reviewer that can read code but not change it.", start: false },
  { file: ".claude/hooks/*", plain: "Automatic checkpoints", does: "Scripts your team owns that run at fixed moments: when a session starts, before every edit, after every action, before finishing. They can block an action.", start: false },
  { file: ".mcp.json", plain: "Approved connections", does: "Which outside systems Claude may use, such as the ticketing system, the data warehouse or monitoring dashboards, using your existing access controls.", start: false },
];

const EVALS = [
  { title: "A fixed test set", body: "20 to 50 real past tasks, each with a known good outcome. Include easy, typical and tricky cases, plus a few things the agent should refuse." },
  { title: "Automatic checks first", body: "Wherever possible, success is decided by a machine: tests pass, the code builds, no guardrail was broken. These are fast, cheap and objective." },
  { title: "A clear rubric for the rest", body: "For things a machine can't judge, such as the quality of a review note, a person or a separate model scores against a short written rubric, the same way every time." },
  { title: "Run it on every change", body: "Re-run the full test set whenever the instructions, skills, hooks or model change, and compare against the last run. That's how you catch a change that made it worse." },
  { title: "Thresholds set in advance", body: "Agree the bar before you look at the results, such as 90% task success and zero guardrail breaches, so decisions are made on the evidence, not on a good demo." },
  { title: "Production feedback", body: "Every correction a person makes in real use becomes a new test case. Over time the test set reflects the work your teams actually do." },
];

const METRICS = [
  ["Task success rate", "Share of test tasks completed correctly", "≥ 90%"],
  ["First-pass acceptance", "Changes kept with little or no human editing", "≥ 80%"],
  ["Guardrail breaches", "Actions that should have been blocked but weren't", "0"],
  ["Blocked attempts", "Actions the hooks and permissions stopped (tracked, not a failure)", "Trend down"],
  ["Human time per task", "Minutes a person spent reviewing or fixing", "Trend down"],
  ["Cost per task", "Model spend per completed task", "Within budget"],
];

function Section({ id, kicker, title, intro, children }: { id: string; kicker: string; title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-12 scroll-mt-24 border-t border-black/10 pt-8">
      <div className="font-mono text-[11px] uppercase tracking-wide text-terracotta">{kicker}</div>
      <h3 className="mt-1 font-serif text-[26px] font-bold leading-tight">{title}</h3>
      {intro && <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-black/65">{intro}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function AgentLifecycle() {
  return (
    <div className="min-h-screen bg-alabaster">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-black/10 bg-alabaster/95 px-4 py-3 backdrop-blur lg:h-[4.5rem] lg:flex-nowrap lg:px-5 lg:py-0">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-charcoal font-serif text-xl font-bold text-terracotta">F</div>
        <h1 className="min-w-0 font-serif text-[17px] font-bold leading-tight sm:text-[20px] lg:whitespace-nowrap">
          FinTechCo <span className="text-black/30">|</span> Building agents
        </h1>
        <nav className="ml-4 hidden gap-1 lg:flex">
          {[
            ["adlc", "Agent lifecycle"],
            ["sdlc", "Delivery with agents"],
            ["teach", "Teaching an agent"],
            ["files", "The files"],
            ["evals", "Evaluations"],
          ].map(([id, label]) => (
            <a key={id} href={`#${id}`} className="rounded-full px-3 py-1 text-[13px] text-black/60 hover:bg-oat hover:text-black">
              {label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2 lg:ml-auto">
          <Link href="/architectures" className="whitespace-nowrap rounded-lg border border-black/15 bg-white px-3 py-1.5 text-[12.5px] font-medium hover:bg-oat">
            How it fits together
          </Link>
          <Link href="/" className="flex items-center gap-1 whitespace-nowrap rounded-lg bg-slate px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110">
            <ArrowLeft className="h-4 w-4" /> Workbench
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        <div className="font-mono text-[11px] uppercase tracking-wide text-black/50">From first experiment to trusted teammate</div>
        <h2 className="mt-1 font-serif text-[28px] font-bold leading-tight sm:text-[34px]">How to build, teach and grow AI agents safely</h2>
        <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-black/65">
          An agent is software that takes on a whole task, not just a single answer: it reads, plans, makes changes, checks its own work and reports back.
          This page covers how agents are developed, how they fit into the way software is delivered, how to teach one your team&apos;s way of working,
          and how to know whether it&apos;s ready for more responsibility.
        </p>
        <div className="mt-4 rounded-xl border border-slate/20 bg-[#eef3f6] px-4 py-3 text-[14px] leading-relaxed text-black/70">
          <b className="text-charcoal">A note on &ldquo;training&rdquo;:</b> with Claude, you don&apos;t retrain the underlying model on your code. You teach an
          agent the way you&apos;d onboard a capable new hire: written guidance, worked examples, clear boundaries, and feedback. All of it lives in plain files
          your team can read, review and change, and none of your code is used to train the model.
        </div>

        <Section
          id="adlc"
          kicker="The agent development lifecycle (ADLC)"
          title="Seven steps from idea to trusted agent"
          intro="Building an agent looks less like writing a program and more like bringing on a new team member: define the role, brief them, set boundaries, check their work, and give more responsibility as trust is earned."
        >
          <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {ADLC.map((s, i) => (
              <li key={s.step} className="rounded-xl border border-black/5 bg-oat p-3.5">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-terracotta text-[12px] font-bold text-white">{i + 1}</span>
                  <span className="text-[14px] font-semibold">{s.step}</span>
                </div>
                <p className="mt-1.5 text-[13px] leading-snug text-black/65">{s.what}</p>
              </li>
            ))}
            <li className="flex items-center justify-center rounded-xl border-2 border-dashed border-terracotta/40 p-3.5 text-center text-[13px] text-terracotta">
              Then repeat steps 5 to 7. An agent is never &ldquo;finished&rdquo;; it keeps improving from real use.
            </li>
          </ol>
        </Section>

        <Section
          id="sdlc"
          kicker="Software delivery with agents"
          title="The same steps your teams follow today, with an agent alongside"
          intro="Agents don't replace the way software is delivered. They take on the repetitive work at each step, while people keep the decisions."
        >
          <div className="overflow-x-auto rounded-xl border border-black/10">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="bg-charcoal text-white">
                <tr>
                  <th className="px-3 py-2 font-semibold">Step</th>
                  <th className="px-3 py-2 font-semibold">What the agent does</th>
                  <th className="px-3 py-2 font-semibold">What people do</th>
                  <th className="px-3 py-2 font-semibold">Claude Code feature</th>
                </tr>
              </thead>
              <tbody>
                {SDLC.map((r, i) => (
                  <tr key={r.phase} className={i % 2 ? "bg-white" : "bg-oat"}>
                    <td className="px-3 py-2.5 font-semibold">{r.phase}</td>
                    <td className="px-3 py-2.5 text-black/70">{r.agent}</td>
                    <td className="px-3 py-2.5 text-black/70">{r.human}</td>
                    <td className="px-3 py-2.5 font-mono text-[11.5px] text-slate">{r.feature}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[12.5px] text-black/50">You can see three of these steps in the live workbench: Build and Test in scenarios 1 and 2, and Review in scenario 3.</p>
        </Section>

        <Section
          id="teach"
          kicker="Teaching an agent"
          title="Start small, then give it more responsibility as it earns trust"
          intro="The most common mistake is starting with the hardest, most visible task. Start with something frequent, low-risk and easy to check, get it reliably right, and grow from there."
        >
          <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
            <div className="rounded-xl bg-charcoal p-4 text-white">
              <div className="font-mono text-[11px] uppercase tracking-wide text-terracotta">What to start with</div>
              <ul className="mt-2 space-y-2 text-[13.5px] leading-snug">
                {[
                  "One task your team does every week that already has good tests, such as fixing failing tests or reviewing pull requests.",
                  "A short CLAUDE.md: 10 to 20 lines on how your team works, not a manual. Add to it whenever someone corrects the agent.",
                  "A permissions file that blocks anything risky from day one, so you never have to trust good behaviour.",
                  "One saved command for the task, so everyone asks for it the same way.",
                  "Ten real past examples with known good answers. That's the start of your test set.",
                ].map((t) => (
                  <li key={t} className="flex gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#7fc495]" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-2">
              <div className="font-mono text-[11px] uppercase tracking-wide text-black/50">How it matures</div>
              {LEVELS.map((l, i) => (
                <div key={l.level} className="relative rounded-xl border border-black/10 bg-white p-3">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-serif text-[16px] font-bold">{l.level}</span>
                    <span className="text-[13px] text-black/65">{l.who}</span>
                  </div>
                  <div className="mt-1 text-[12.5px] text-black/55">
                    <b className="text-black/70">Allowed:</b> {l.unlock}
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-sage">
                    <b>Move up when:</b> {l.gate}
                  </div>
                  {i < LEVELS.length - 1 && <ArrowRight className="absolute -bottom-3 left-6 z-[1] h-5 w-5 rotate-90 rounded-full bg-alabaster text-terracotta" />}
                </div>
              ))}
            </div>
          </div>
        </Section>

        <Section
          id="files"
          kicker="The files"
          title="What each file does, in plain terms"
          intro="Everything that shapes how the agent behaves is a readable file kept with the code. That means it's reviewed, versioned and auditable, like any other change."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {FILES.map((f) => (
              <div key={f.file} className="rounded-xl border border-black/5 bg-oat p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-white px-1.5 py-0.5 text-[12px] text-slate">{f.file}</code>
                  <span className="text-[13.5px] font-semibold">{f.plain}</span>
                  {f.start && <span className="ml-auto rounded-full bg-sage/15 px-2 py-0.5 text-[11px] font-medium text-sage">Start with this</span>}
                </div>
                <p className="mt-1.5 text-[13px] leading-snug text-black/65">{f.does}</p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[12.5px] text-black/50">
            The workbench demo uses real versions of several of these: CLAUDE.md, settings.json with permissions, hooks and a sandbox, and an Architecture
            Patterns skill. Open Governance on the workbench to read them.
          </p>
        </Section>

        <Section
          id="evals"
          kicker="Evaluations"
          title="What a good agent evaluation framework looks like"
          intro="An evaluation, or eval, is a repeatable test of whether the agent does the job well. It's the difference between &ldquo;the demo looked good&rdquo; and &ldquo;we know it works, and we'll know if it gets worse.&rdquo;"
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {EVALS.map((e) => (
              <div key={e.title} className="rounded-xl border border-black/5 bg-oat p-3.5">
                <div className="text-[14px] font-semibold">{e.title}</div>
                <p className="mt-1 text-[13px] leading-snug text-black/65">{e.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 overflow-x-auto rounded-xl border border-black/10">
            <table className="w-full min-w-[600px] text-left text-[13px]">
              <thead className="bg-charcoal text-white">
                <tr>
                  <th className="px-3 py-2 font-semibold">What we measure</th>
                  <th className="px-3 py-2 font-semibold">What it means</th>
                  <th className="px-3 py-2 font-semibold">Example bar</th>
                </tr>
              </thead>
              <tbody>
                {METRICS.map(([m, d, t], i) => (
                  <tr key={m} className={i % 2 ? "bg-white" : "bg-oat"}>
                    <td className="px-3 py-2.5 font-semibold">{m}</td>
                    <td className="px-3 py-2.5 text-black/70">{d}</td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-sage">{t}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 rounded-xl bg-charcoal px-4 py-3 text-[13.5px] leading-relaxed text-white">
            <span className="font-mono text-[11px] uppercase tracking-wide text-terracotta">In the workbench</span>
            <br />
            Each scenario is a small eval. The checks fail before Claude starts (0 of 4) and pass after (4 of 4), the hooks count every blocked action, and
            the audit log records every step. A real program would run dozens of these on every change and track the results over time.
          </div>
          <p className="mt-2 text-[12px] text-black/45">Bars shown are examples to agree with your teams, not fixed industry standards.</p>
        </Section>

        <footer className="mt-14 flex flex-wrap items-center justify-between gap-2 border-t border-black/10 pt-6 text-[12px] text-black/45">
          <span>Building agents with Claude Code: lifecycle, delivery, teaching and evaluation.</span>
          <Link href="/" className="font-medium text-slate hover:underline">
            Back to the live Workbench →
          </Link>
        </footer>
      </main>
    </div>
  );
}
