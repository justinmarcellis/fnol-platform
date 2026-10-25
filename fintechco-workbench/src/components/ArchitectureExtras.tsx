import { RefreshCw } from "lucide-react";
import { FRAUD_LOOP, REVIEW_JUDGE } from "@/lib/architectureExtras";
import FraudCaseDesk from "./FraudCaseDesk";

/** Fraud claims: the five-step feedback loop, then the clickable case desk. */
export function FraudExtras() {
  return (
    <>
      <div className="mt-5 rounded-xl border border-dashed border-terracotta bg-white p-4">
        <div className="font-mono text-[11px] uppercase tracking-wide text-black/50">{FRAUD_LOOP.title}</div>
        <p className="mt-1 text-[13.5px] text-black/65">{FRAUD_LOOP.intro}</p>
        <ol className="mt-3 grid gap-2 lg:grid-cols-5">
          {FRAUD_LOOP.steps.map((s, i) => (
            <li key={s.name} className={`flex min-w-0 gap-2 rounded-lg px-2.5 py-2 ${i === FRAUD_LOOP.steps.length - 1 ? "bg-[#eef6ef]" : "bg-oat"}`}>
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-terracotta font-mono text-[11px] font-semibold text-terracotta">
                {i + 1}
              </span>
              <span>
                <span className="block text-[13px] font-semibold leading-tight">{s.name}</span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-black/55">{s.note}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-2 flex items-center justify-end gap-1 font-mono text-[11px] text-terracotta">
          <RefreshCw className="h-3 w-3" /> {FRAUD_LOOP.back}
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="font-serif text-[18px] font-bold">Try the case desk</h4>
        <p className="text-[13px] text-black/50">What an analyst sees for one email report. Fictional customer and data.</p>
      </div>
      <FraudCaseDesk />
    </>
  );
}

/** Pull request review: the judge's rubric and the three signals behind the release gate. */
export function ReviewJudge() {
  const j = REVIEW_JUDGE;
  return (
    <div className="mt-5 grid gap-4 rounded-xl border border-[#e2c27a] bg-[#fbf4e2] p-4 lg:grid-cols-[1.2fr_1fr]">
      <div className="min-w-0">
        <div className="font-mono text-[11px] uppercase tracking-wide text-black/50">{j.rubricTitle}</div>
        <p className="mt-1.5 text-[13.5px] text-black/65">{j.rubricIntro}</p>
        <div className="mt-2 overflow-x-auto rounded-lg border border-black/10 bg-white">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-black/50">
                <th className="px-2.5 py-2 font-semibold">Question</th>
                <th className="px-2.5 py-2 font-semibold">What it checks</th>
                <th className="px-2.5 py-2 text-right font-semibold">Avg score</th>
              </tr>
            </thead>
            <tbody>
              {j.rubric.map((r) => (
                <tr key={r.question} className="border-t border-black/10">
                  <td className="px-2.5 py-2 font-semibold">{r.question}</td>
                  <td className="px-2.5 py-2">{r.checks}</td>
                  <td className="px-2.5 py-2 text-right tabular-nums">{r.score.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="font-mono text-[11px] uppercase tracking-wide text-black/50">{j.signalsTitle}</div>
        <ul className="space-y-1.5">
          {j.signals.map((s) => (
            <li key={s.name} className="rounded-lg bg-white/80 px-2.5 py-1.5 shadow-sm">
              <div className="text-[13px] font-semibold leading-tight">{s.name}</div>
              <div className="text-[11.5px] leading-snug text-black/55">{s.note}</div>
            </li>
          ))}
        </ul>
        <div className="border-l-[3px] border-sage pl-2.5 text-[13px] font-semibold">{j.gate}</div>
        <p className="text-[12px] text-black/50">{j.footnote}</p>
      </div>
    </div>
  );
}
