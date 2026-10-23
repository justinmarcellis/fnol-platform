import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft, ArrowRight, Check, Cloud, Lock } from "lucide-react";
import DecisionMap from "@/components/DecisionMap";
import { LANGUAGES, SPRINTS } from "@/lib/buildstory";

export const metadata: Metadata = {
  title: "How This Was Built",
  description: "The architecture, languages, cloud boundary, sprints and decisions behind the FinTechCo Workbench.",
};

const TAG_TONE: Record<string, string> = {
  Feature: "bg-slate/15 text-slate",
  Reliability: "bg-sage/15 text-sage",
  Quality: "bg-sage/15 text-sage",
  Design: "bg-terracotta/15 text-terracotta",
  Deploy: "bg-charcoal/10 text-charcoal",
  Content: "bg-charcoal/10 text-charcoal",
  Security: "bg-[#da3633]/10 text-[#b62324]",
};

function Box({ title, note, tone = "bg-white" }: { title: string; note: string; tone?: string }) {
  return (
    <div className={`rounded-lg border border-black/10 px-3 py-2 shadow-sm ${tone}`}>
      <div className="text-[13px] font-semibold leading-tight">{title}</div>
      <div className="mt-0.5 text-[11.5px] leading-snug text-black/55">{note}</div>
    </div>
  );
}

function Section({ kicker, title, children }: { kicker: string; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-12 border-t border-black/10 pt-8">
      <div className="font-mono text-[11px] uppercase tracking-wide text-terracotta">{kicker}</div>
      <h3 className="mt-1 font-serif text-[26px] font-bold leading-tight">{title}</h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function HowItWasBuilt() {
  return (
    <div className="min-h-screen bg-alabaster">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-black/10 bg-alabaster/95 px-4 py-3 backdrop-blur lg:h-[4.5rem] lg:px-5 lg:py-0">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-charcoal font-serif text-xl font-bold text-terracotta">F</div>
        <h1 className="min-w-0 font-serif text-[17px] font-bold leading-tight sm:text-[20px]">
          FinTechCo <span className="text-black/30">|</span> How this was built
        </h1>
        <Link href="/" className="flex items-center gap-1 whitespace-nowrap rounded-lg bg-slate px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 lg:ml-auto">
          <ArrowLeft className="h-4 w-4" /> Workbench
        </Link>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        <div className="font-mono text-[11px] uppercase tracking-wide text-black/50">Built with Claude Code</div>
        <h2 className="mt-1 font-serif text-[28px] font-bold leading-tight sm:text-[34px]">From a prompt to a live, governed demo in an afternoon</h2>
        <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-black/65">
          This workbench was planned, written, tested, deployed and revised with Claude Code, working from plain-English requests. Here&apos;s what was
          built, where it runs, and how each decision was made.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {["About 4 hours of hands-on work", "15 reviewed commits", "≈3,400 lines", "1 cloud service, no database", "Pennies per demo run"].map((s) => (
            <span key={s} className="rounded-full bg-oat px-3 py-1 text-[12.5px] font-medium">
              {s}
            </span>
          ))}
        </div>

        <Section kicker="Architecture" title="How a click becomes a result">
          <div className="grid items-center gap-2 lg:grid-cols-[1fr_auto_1fr_auto_1.3fr_auto_1fr]">
            <Box title="Your browser" note="Plays each run back line by line, at reading speed" />
            <ArrowRight className="mx-auto h-5 w-5 rotate-90 text-terracotta lg:rotate-0" />
            <Box title="Firebase Hosting" note="The fintechco-workbench.web.app address" />
            <ArrowRight className="mx-auto h-5 w-5 rotate-90 text-terracotta lg:rotate-0" />
            <div className="rounded-xl border-2 border-slate/40 bg-[#eef3f6] p-2.5">
              <div className="font-mono text-[10.5px] uppercase tracking-wide text-slate">Cloud Run · one container</div>
              <div className="mt-1.5 grid gap-1.5">
                <Box title="Next.js web server" note="Pages and the run, reset and fraud-check APIs" />
                <Box title="Private workspace per visitor" note="A fresh copy of the demo files, deleted after 3 idle hours" />
                <Box title="Python automated checks" note="The same tests run before and after every fix" />
              </div>
            </div>
            <ArrowRight className="mx-auto h-5 w-5 rotate-90 text-terracotta lg:rotate-0" />
            <Box title="Claude Code (live mode)" note="Runs headless when a key is set; falls back to a reviewed replay if it stalls" tone="bg-[#fbf4e2]" />
          </div>
          <div className="mt-3 rounded-lg bg-oat px-4 py-3 text-[13px] text-black/65">
            <b className="text-charcoal">How updates ship:</b> code is reviewed on GitHub, then one command (<code>deploy.sh</code>) builds the container in
            Cloud Build, rolls it out on Cloud Run, publishes the web.app address, and confirms both serve the new version.
          </div>
        </Section>

        <Section kicker="Languages" title="What it's written in">
          <div className="space-y-2.5">
            {LANGUAGES.map((l) => (
              <div key={l.name} className="grid items-center gap-x-4 gap-y-1 sm:grid-cols-[150px_1fr_2fr]">
                <div className="text-[14px] font-semibold">{l.name}</div>
                <div className="flex items-center gap-2">
                  <div className="h-2.5 flex-1 rounded-full bg-oat">
                    <div className="h-2.5 rounded-full bg-terracotta" style={{ width: `${Math.max(l.share, 2)}%` }} />
                  </div>
                  <span className="w-20 text-right font-mono text-[11.5px] text-black/50">{l.lines.toLocaleString("en-US")} lines</span>
                </div>
                <div className="text-[13px] text-black/60">{l.use}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section kicker="Cloud perimeter" title="What runs where, and what crosses the line">
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <div className="rounded-2xl border-2 border-dashed border-slate/50 bg-white/60 p-4">
              <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-slate">
                <Cloud className="h-4 w-4" /> Inside one Google Cloud project
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Box title="Firebase Hosting" note="Public address, HTTPS only" />
                <Box title="Cloud Run" note="One instance; nothing stored after a restart" />
                <Box title="Cloud Build + Artifact Registry" note="Builds and stores the container" />
                <Box title="Secret Manager" note="Holds the model key for live mode, never in code" />
              </div>
              <div className="mt-3 flex items-start gap-2 rounded-lg bg-sage/10 px-3 py-2 text-[12.5px] text-sage">
                <Lock className="mt-0.5 h-4 w-4 shrink-0" /> No customer data anywhere: every card number, payment and order in the demo is made up.
              </div>
            </div>
            <div className="space-y-2">
              <div className="font-mono text-[11px] uppercase tracking-wide text-black/50">What crosses the boundary</div>
              {[
                ["Visitors", "Web pages and results over HTTPS. Nothing else."],
                ["Model provider", "Live mode only. Under enterprise terms, prompts aren't kept or used for training."],
                ["GitHub", "Source code in, reviewed through pull requests."],
              ].map(([t, n]) => (
                <Box key={t} title={t} note={n} />
              ))}
            </div>
          </div>
        </Section>

        <Section kicker="Sprint board" title="How it came together">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {SPRINTS.map((s) => (
              <div key={s.name} className="rounded-xl bg-oat p-3">
                <div className="flex items-baseline justify-between">
                  <div className="text-[13.5px] font-semibold">{s.name}</div>
                  <div className="font-mono text-[11px] text-black/45">{s.when}</div>
                </div>
                <div className="mt-2 space-y-1.5">
                  {s.cards.map((c) => (
                    <div key={c.title} className="rounded-lg bg-white px-2.5 py-2 shadow-sm">
                      <div className="text-[12.5px] leading-snug">{c.title}</div>
                      <div className="mt-1.5 flex items-center justify-between">
                        <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${TAG_TONE[c.tag] ?? ""}`}>{c.tag}</span>
                        <Check className="h-3.5 w-3.5 text-sage" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-black/45">Grouped from the repository&apos;s commit history. Every card shipped as a reviewed change.</p>
        </Section>

        <Section kicker="Decision replay" title="How each decision was made">
          <p className="-mt-1 mb-3 max-w-3xl text-[14px] text-black/60">
            Drawn like a neural network: each request flows into a decision, and each decision into the outcome it served. It&apos;s a map of the
            reasoning, not a trained model.
          </p>
          <DecisionMap />
        </Section>

        <footer className="mt-14 flex flex-wrap items-center justify-between gap-2 border-t border-black/10 pt-6 text-[12px] text-black/45">
          <span>Built with Claude Code, deployed on Google Cloud.</span>
          <Link href="/agent-lifecycle" className="font-medium text-slate hover:underline">
            How teams build and grow agents →
          </Link>
          <Link href="/" className="font-medium text-slate hover:underline">
            Back to the live Workbench →
          </Link>
        </footer>
      </main>
    </div>
  );
}
