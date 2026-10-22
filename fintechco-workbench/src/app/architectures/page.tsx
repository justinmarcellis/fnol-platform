import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft, ArrowRight, ExternalLink, ShieldCheck, TriangleAlert } from "lucide-react";
import { ARCHITECTURES, type Lane } from "@/lib/architectures";

export const metadata: Metadata = {
  title: "FinTechCo Reference Architectures",
  description: "Executive view of the Claude Code on Google Cloud reference architectures.",
};

const LANE_TONE: Record<Lane["tone"], string> = {
  people: "border-black/10 bg-white",
  workspace: "border-[#b9a7d9] bg-[#f3eefb]",
  platform: "border-[#e2c27a] bg-[#fbf4e2]",
  data: "border-[#9fc7a8] bg-[#eef6ef]",
};

export default function ArchitecturesPage() {
  return (
    <div className="min-h-screen bg-alabaster">
      <header className="sticky top-0 z-10 flex h-[4.5rem] items-center gap-3 border-b border-black/10 bg-alabaster/95 px-5 backdrop-blur">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-charcoal font-serif text-xl font-bold text-terracotta">
          F
        </div>
        <h1 className="whitespace-nowrap font-serif text-[20px] font-bold leading-tight">
          FinTechCo <span className="text-black/30">|</span> Reference Architectures
        </h1>
        <nav className="ml-6 hidden gap-1 lg:flex">
          {ARCHITECTURES.map((a) => (
            <a key={a.id} href={`#${a.id}`} className="rounded-full px-3 py-1 font-mono text-[12px] text-black/60 hover:bg-oat hover:text-black">
              {a.code}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <a
            href="https://fintechco-roi.web.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 whitespace-nowrap rounded-lg border border-black/15 bg-white px-3 py-1.5 text-[12.5px] font-medium hover:bg-oat"
          >
            ROI Calculator <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <Link href="/" className="flex items-center gap-1 whitespace-nowrap rounded-lg bg-slate px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110">
            <ArrowLeft className="h-4 w-4" /> Workbench
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="font-mono text-[11px] uppercase tracking-wide text-black/50">Claude Code on Google Cloud</div>
        <h2 className="mt-1 font-serif text-[34px] font-bold leading-tight">One foundation, two high-value patterns</h2>
        <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-black/65">
          The platform team builds the foundation once. Rapid prototyping and data cleansing then inherit its model access, guardrails,
          telemetry and cost controls, so every new team starts governed on day one.
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {ARCHITECTURES.map((a) => (
            <a key={a.id} href={`#${a.id}`} className="group rounded-xl border border-black/5 bg-oat p-4 transition hover:border-terracotta">
              <div className="font-mono text-[11px] text-terracotta">{a.code}</div>
              <div className="mt-1 font-serif text-[17px] font-bold leading-snug">{a.title}</div>
              <div className="mt-1 text-[13px] text-black/60">{a.headline}</div>
              <div className="mt-2 flex items-center gap-1 text-[12px] font-medium text-slate group-hover:gap-2">
                View <ArrowRight className="h-3.5 w-3.5" />
              </div>
            </a>
          ))}
        </div>

        {ARCHITECTURES.map((a) => (
          <section key={a.id} id={a.id} className="mt-14 scroll-mt-24 border-t border-black/10 pt-10">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="rounded-md bg-charcoal px-2 py-0.5 font-mono text-[13px] font-bold text-terracotta">{a.code}</span>
              <h3 className="font-serif text-[28px] font-bold leading-tight">{a.title}</h3>
            </div>
            <div className="mt-1 font-mono text-[12px] text-black/50">{a.valueStatement}</div>
            <p className="mt-3 font-serif text-[19px] leading-snug">{a.headline}</p>
            <blockquote className="mt-4 border-l-4 border-terracotta pl-4 text-[14.5px] italic leading-relaxed text-black/70">“{a.quote}”</blockquote>

            {/* Simplified diagram: four lanes, left to right */}
            <div className="mt-6 grid gap-3 lg:grid-cols-4">
              {a.lanes.map((lane, i) => (
                <div key={lane.label} className="relative">
                  <div className={`h-full rounded-xl border p-3 ${LANE_TONE[lane.tone]}`}>
                    <div className="font-mono text-[10.5px] uppercase tracking-wide text-black/55">{lane.label}</div>
                    <ul className="mt-2 space-y-1.5">
                      {lane.items.map((it) => (
                        <li key={it.name} className="rounded-lg bg-white/80 px-2.5 py-1.5 shadow-sm">
                          <div className="text-[13px] font-semibold leading-tight">{it.name}</div>
                          {it.note && <div className="text-[11.5px] leading-snug text-black/55">{it.note}</div>}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {i < a.lanes.length - 1 && (
                    <ArrowRight className="absolute -right-3 top-1/2 z-[1] hidden h-5 w-5 -translate-y-1/2 rounded-full bg-alabaster text-terracotta lg:block" />
                  )}
                </div>
              ))}
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
              <div>
                <h4 className="font-serif text-[18px] font-bold">How it works</h4>
                <ol className="mt-2 space-y-2">
                  {a.steps.map((s, i) => (
                    <li key={i} className="flex gap-3 text-[14px] leading-relaxed text-black/75">
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate text-[12px] font-bold text-white">{i + 1}</span>
                      {s}
                    </li>
                  ))}
                </ol>
              </div>
              <div>
                <h4 className="font-serif text-[18px] font-bold">Where the value lives</h4>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {a.value.map((v) => (
                    <div key={v.code} className="rounded-lg border border-black/5 bg-oat p-3">
                      <div className="font-mono text-[10.5px] uppercase tracking-wide text-terracotta">{v.code}</div>
                      <div className="mt-0.5 text-[13px] font-semibold leading-snug">{v.title}</div>
                      <div className="mt-1 text-[12px] text-sage">Measure: {v.metric}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl bg-charcoal p-4 text-white">
                <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-terracotta">
                  <ShieldCheck className="h-4 w-4" /> {a.id === "foundation" ? "Value loop" : "Guardrails & value"}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {a.guardrails.map((g, i) => (
                    <span key={g} className="flex items-center gap-1.5">
                      <span className="rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-[12px]">{g}</span>
                      {a.id === "foundation" && i < a.guardrails.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-terracotta" />}
                    </span>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border border-black/10 bg-white p-4">
                <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-black/55">
                  <TriangleAlert className="h-4 w-4 text-terracotta" /> Watch-outs
                </div>
                <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-black/70">
                  {a.watchouts.map((w) => (
                    <li key={w} className="flex gap-2">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-terracotta" />
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        ))}

        <footer className="mt-14 flex items-center justify-between border-t border-black/10 pt-6 text-[12px] text-black/45">
          <span>Based on the Claude Code on Google Cloud reference architectures (F2, RA7, RA8).</span>
          <Link href="/" className="font-medium text-slate hover:underline">
            Back to the live Workbench →
          </Link>
        </footer>
      </main>
    </div>
  );
}
