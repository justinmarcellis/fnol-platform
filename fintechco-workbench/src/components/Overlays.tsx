"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { OBJECTIONS, TALK_TRACKS } from "@/lib/talktrack";
import { AuditLog, PermissionTester } from "./GovernanceExtras";
import type { TermLine } from "./Terminal";

export function GovernanceModal({
  open,
  onClose,
  claudeMd,
  settingsJson,
  lines = [],
}: {
  open: boolean;
  onClose: () => void;
  claudeMd: string;
  settingsJson: string;
  lines?: TermLine[];
}) {
  const [tab, setTab] = useState<"md" | "json" | "try" | "audit">("md");
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-charcoal/50 p-3 sm:p-6" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-alabaster shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-black/10 px-6 py-4">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-wide text-black/50">The rules Claude follows</div>
            <h2 className="font-serif text-2xl font-bold">Governance</h2>
          </div>
          <button onClick={onClose} className="ml-auto rounded-lg p-1.5 hover:bg-oat" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex flex-wrap gap-1 px-6 pt-3">
          {(
            [
              ["md", "Our rules"],
              ["json", "Permissions"],
              ["try", "Try a permission"],
              ["audit", "Audit log"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-t-lg px-4 py-2 font-mono text-[13px] ${tab === k ? "bg-term text-white" : "bg-oat text-black/60"}`}
            >
              {label}
            </button>
          ))}
          <span className="ml-auto self-center text-[12px] text-black/50">
            {
              {
                md: "Written rules Claude reads at the start of every session",
                json: "What Claude is allowed to do (green) and blocked from doing (red)",
                try: "See how the permissions decide, live",
                audit: "A record of every action, and why it was allowed",
              }[tab]
            }
          </span>
        </div>
        {tab === "md" || tab === "json" ? (
          <pre className="scroll-dark mx-6 mb-6 min-h-0 flex-1 overflow-auto rounded-b-lg rounded-tr-lg bg-term p-5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-[#e6edf3]">
            {tab === "md" ? <Markdownish text={claudeMd} /> : <JsonHighlight text={settingsJson} />}
          </pre>
        ) : (
          <div className="scroll-dark mx-6 mb-6 min-h-0 flex-1 overflow-auto rounded-b-lg rounded-tr-lg bg-term text-[#e6edf3]">
            {tab === "try" ? <PermissionTester settingsJson={settingsJson} /> : <AuditLog lines={lines} />}
          </div>
        )}
      </div>
    </div>
  );
}

function Markdownish({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <div key={i} className={line.startsWith("#") ? "font-bold text-terracotta" : line.includes("**Rule") ? "text-[#e6edf3]" : "text-[#8b949e]"}>
          {line || " "}
        </div>
      ))}
    </>
  );
}

function JsonHighlight({ text }: { text: string }) {
  let section = "";
  return (
    <>
      {text.split("\n").map((line, i) => {
        if (/"allow"/.test(line)) section = "allow";
        else if (/"deny"/.test(line)) section = "deny";
        else if (/\]/.test(line)) section = "";
        const isItem = section && /^\s+"/.test(line) && !/"(allow|deny)"/.test(line);
        const cls = isItem ? (section === "allow" ? "text-[#56d364]" : "text-[#f85149]") : /"env"|"permissions"/.test(line) ? "text-[#79c0ff]" : "text-[#c9d1d9]";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </>
  );
}

export function TalkTrackDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      <div className={`fixed inset-0 z-40 bg-charcoal/30 transition-opacity ${open ? "opacity-100" : "pointer-events-none opacity-0"}`} onClick={onClose} />
      <aside
        className={`fixed right-0 top-0 z-50 flex h-full w-[520px] max-w-full flex-col bg-alabaster shadow-2xl transition-transform duration-300 ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center border-b border-black/10 px-6 py-4">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-wide text-black/50">Presenter only</div>
            <h2 className="font-serif text-2xl font-bold">Presenter notes · about 11 min</h2>
          </div>
          <button onClick={onClose} className="ml-auto rounded-lg p-1.5 hover:bg-oat" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {TALK_TRACKS.map((t) => (
            <section key={t.scenario}>
              <div className="flex items-baseline gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-terracotta text-[12px] font-bold text-white">{t.scenario}</span>
                <h3 className="font-serif text-[17px] font-bold">{t.title}</h3>
                <span className="ml-auto font-mono text-[11px] text-black/50">{t.minutes}</span>
              </div>
              <ol className="mt-2 space-y-1.5 pl-8 text-[13px] leading-relaxed text-black/75">
                {t.beats.map((b, i) => (
                  <li key={i} className="list-decimal">
                    {b}
                  </li>
                ))}
              </ol>
            </section>
          ))}
          <section>
            <h3 className="font-serif text-[17px] font-bold">Likely questions</h3>
            <div className="mt-2 space-y-2.5">
              {OBJECTIONS.map((o) => (
                <div key={o.topic} className="rounded-lg bg-oat p-3">
                  <div className="font-mono text-[10.5px] uppercase tracking-wide text-slate">{o.topic}</div>
                  <div className="mt-0.5 text-[13px] font-semibold">{o.question}</div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-black/70">{o.answer}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}
