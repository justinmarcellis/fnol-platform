"use client";

import { useEffect, useRef } from "react";
import type { LogTag, Mode } from "@/lib/scenarios";

export interface TermLine {
  id: number;
  tag: LogTag;
  text: string;
}

const TAGS: Record<LogTag, { label: string; cls: string }> = {
  cmd: { label: "", cls: "text-[#e6edf3]" },
  init: { label: "[init]", cls: "text-[#58a6ff]" },
  read: { label: "[tool:Read]", cls: "text-[#79c0ff]" },
  grep: { label: "[tool:Grep]", cls: "text-[#d2a8ff]" },
  reasoning: { label: "[reasoning]", cls: "text-[#c9b8ff]" },
  edit: { label: "[tool:Edit]", cls: "text-[#e3b341]" },
  bash: { label: "[tool:Bash]", cls: "text-[#3fb950]" },
  out: { label: "  │", cls: "text-[#7d8590]" },
  pass: { label: "[PASSED]", cls: "text-[#3fb950]" },
  fail: { label: "[FAILED]", cls: "text-[#f85149]" },
  guard: { label: "[guard]", cls: "text-[#f0883e]" },
  done: { label: "[done]", cls: "text-[#3fb950]" },
};

export default function Terminal({
  lines,
  running,
  elapsedMs,
  mode,
}: {
  lines: TermLine[];
  running: boolean;
  elapsedMs: number;
  mode: Mode;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [lines]);

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-termline bg-term shadow-lg">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-termline bg-term2 px-3">
        <div className="flex gap-1.5">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        <span className="font-mono text-[12px] text-[#7d8590]">claude — /tmp/demo-workspace</span>
        <span
          className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[10.5px] ${mode === "live" ? "bg-[#238636]/30 text-[#3fb950]" : "bg-[#9e6a03]/30 text-[#e3b341]"}`}
        >
          {mode === "live" ? "LIVE CLI" : "SAFE MODE"}
        </span>
        <span className="w-14 text-right font-mono text-[12px] tabular-nums text-[#e6edf3]">{(elapsedMs / 1000).toFixed(1)}s</span>
      </div>
      <div className="scroll-dark min-h-0 flex-1 overflow-y-auto p-4 font-mono text-[12px] leading-[1.55]">
        {lines.length === 0 && (
          <div className="text-[#7d8590]">
            <div>FinTechCo headless Claude Code runner · stream-json → NDJSON</div>
            <div className="mt-1">Click Run Claude Code on a scenario to start.</div>
            <div className="mt-3 text-[#e6edf3]">
              $ <span className="cursor-blink">▋</span>
            </div>
          </div>
        )}
        {lines.map((l) => {
          const t = TAGS[l.tag];
          return (
            <div key={l.id} className="line-in whitespace-pre-wrap break-words">
              {l.tag === "cmd" ? (
                <span className="text-[#e6edf3]">{l.text}</span>
              ) : (
                <>
                  <span className={`font-semibold ${t.cls}`}>{t.label}</span>{" "}
                  <span className={l.tag === "out" ? "text-[#8b949e]" : l.tag === "done" ? "font-semibold text-[#e6edf3]" : "text-[#c9d1d9]"}>{l.text}</span>
                </>
              )}
            </div>
          );
        })}
        {running && (
          <div className="text-[#7d8590]">
            <span className="cursor-blink">▋</span>
          </div>
        )}
        <div ref={end} />
      </div>
    </section>
  );
}
