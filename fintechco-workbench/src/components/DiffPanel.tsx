"use client";

import { useMemo, useState } from "react";
import { Check, ClipboardCopy, FileDiff } from "lucide-react";
import { diffLines, diffStats } from "@/lib/diff";
import { getScenario } from "@/lib/scenarios";
import type { RunResult } from "./Workbench";

export default function DiffPanel({ result }: { result?: RunResult }) {
  const [tab, setTab] = useState(0);
  const [copied, setCopied] = useState(false);
  const files = result?.files ?? [];
  const file = files[Math.min(tab, Math.max(files.length - 1, 0))];
  const lines = useMemo(() => (file ? diffLines(file.before, file.after) : []), [file]);

  const copySummary = async () => {
    if (!result) return;
    const s = getScenario(result.scenarioId)!;
    const md = [
      `## ${s.title}`,
      "",
      "Prepared by Claude Code, following FinTechCo's engineering rules.",
      "",
      "### What changed",
      ...files.map((f) => {
        const st = diffStats(f.before, f.after);
        return `- \`${f.path}\` (+${st.added} / −${st.removed})${f.before ? "" : " — new file"}`;
      }),
      "",
      "### How we know it works",
      `- Automated checks: **${result.pytest.passed} of ${result.pytest.total} passed**`,
      "- The checks themselves were not changed",
      `- Cost of this run: $${result.metrics.costUsd.toFixed(3)}${result.metrics.estimated ? " (est.)" : ""}, ${result.metrics.tokens.toLocaleString("en-US")} tokens`,
    ].join("\n");
    await navigator.clipboard.writeText(md).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="flex h-[55vh] flex-col overflow-hidden rounded-xl border border-termline bg-term lg:h-auto lg:min-h-0 lg:flex-1">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-termline bg-term2 px-3 py-1.5 lg:flex-nowrap lg:py-0">
        <FileDiff className="h-4 w-4 text-[#7d8590]" />
        <span className="truncate font-mono text-[12px] text-[#e6edf3]">What changed</span>
        {result && (
          <>
            <span
              className={`sm:ml-auto whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold ${result.pytest.ok ? "bg-sage text-white" : "bg-[#da3633] text-white"}`}
            >
              {result.pytest.passed} of {result.pytest.total} checks {result.pytest.ok ? "passed" : "failed"}
            </span>
            <button
              onClick={copySummary}
              className="flex items-center gap-1 whitespace-nowrap rounded-md border border-termline px-2 py-0.5 text-[11px] text-[#c9d1d9] hover:bg-white/5"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-[#3fb950]" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy summary for reviewers"}
            </button>
          </>
        )}
      </div>
      {files.length > 0 && (
        <div className="flex shrink-0 gap-1 border-b border-termline px-2 pt-1.5">
          {files.map((f, i) => {
            const st = diffStats(f.before, f.after);
            return (
              <button
                key={f.path}
                onClick={() => setTab(i)}
                className={`whitespace-nowrap rounded-t-md px-2.5 py-1 font-mono text-[11.5px] ${i === tab ? "bg-term2 text-[#e6edf3]" : "text-[#7d8590] hover:text-[#c9d1d9]"}`}
              >
                {f.path} <span className="text-[#3fb950]">+{st.added}</span> <span className="text-[#f85149]">−{st.removed}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="scroll-dark min-h-0 flex-1 overflow-auto font-mono text-[11.5px] leading-[1.55]">
        {!file && (
          <div className="p-4 text-[#7d8590]">Run a scenario to see exactly what Claude changed. Red lines were removed, green lines were added.</div>
        )}
        {file &&
          lines.map((l, i) => (
            <div
              key={i}
              className={`flex ${l.kind === "add" ? "bg-[#2ea043]/15" : l.kind === "del" ? "bg-[#f85149]/15" : ""}`}
            >
              <span className="w-9 shrink-0 select-none pr-2 text-right text-[#484f58]">{l.oldNo ?? ""}</span>
              <span className="w-9 shrink-0 select-none pr-2 text-right text-[#484f58]">{l.newNo ?? ""}</span>
              <span className={`w-4 shrink-0 select-none ${l.kind === "add" ? "text-[#3fb950]" : l.kind === "del" ? "text-[#f85149]" : "text-[#484f58]"}`}>
                {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
              </span>
              <span className={`whitespace-pre pr-4 ${l.kind === "add" ? "text-[#aff5b4]" : l.kind === "del" ? "text-[#ffdcd7]" : "text-[#8b949e]"}`}>
                {l.text || " "}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}
