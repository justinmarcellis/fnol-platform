"use client";

import { useEffect, useRef } from "react";
import type { LogTag, Mode } from "@/lib/scenarios";

export interface TermLine {
  id: number;
  tag: LogTag;
  text: string;
  /** When the line appeared; used by the audit log. */
  at?: number;
}

const TAGS: Record<LogTag, { label: string; cls: string }> = {
  cmd: { label: "", cls: "text-[#e6edf3]" },
  init: { label: "[setup]", cls: "text-[#58a6ff]" },
  read: { label: "[reading]", cls: "text-[#79c0ff]" },
  grep: { label: "[found]", cls: "text-[#d2a8ff]" },
  reasoning: { label: "[thinking]", cls: "text-[#c9b8ff]" },
  edit: { label: "[editing]", cls: "text-[#e3b341]" },
  bash: { label: "[running]", cls: "text-[#3fb950]" },
  out: { label: "  │", cls: "text-[#7d8590]" },
  pass: { label: "[passed]", cls: "text-[#3fb950]" },
  fail: { label: "[failed]", cls: "text-[#f85149]" },
  guard: { label: "[note]", cls: "text-[#f0883e]" },
  hook: { label: "[hook]", cls: "text-[#ff7b72]" },
  done: { label: "[done]", cls: "text-[#3fb950]" },
};

export default function Terminal({
  lines,
  running,
  mode,
}: {
  lines: TermLine[];
  running: boolean;
  mode: Mode;
}) {
  const body = useRef<HTMLDivElement>(null);
  // Scroll only the terminal, not the page (scrollIntoView would also move the page on phones).
  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [lines]);

  return (
    <section id="terminal" data-tour="terminal" className="flex h-[65vh] scroll-mt-3 flex-col overflow-hidden rounded-xl border border-termline bg-term shadow-lg lg:h-auto lg:min-h-0">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-termline bg-term2 px-3">
        <div className="flex gap-1.5">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        <span className="truncate font-mono text-[12px] text-[#7d8590]">claude — /tmp/demo-workspace</span>
        <span
          className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[10.5px] ${mode === "live" ? "bg-[#238636]/30 text-[#3fb950]" : "bg-[#9e6a03]/30 text-[#e3b341]"}`}
        >
          {mode === "live" ? "LIVE" : "REPLAY"}
        </span>
      </div>
      <div ref={body} className="scroll-dark min-h-0 flex-1 overflow-y-auto p-4 font-mono text-[12px] leading-[1.55]">
        {lines.length === 0 && (
          <div className="text-[#7d8590]">
            <div>Claude Code is ready.</div>
            <div className="mt-1">Pick a scenario on the left and click Run.</div>
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
      </div>
    </section>
  );
}
