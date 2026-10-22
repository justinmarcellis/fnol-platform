"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, Play, RotateCcw } from "lucide-react";
import { SCENARIOS, type LogTag, type Mode, type ScenarioId, type StreamEvent } from "@/lib/scenarios";
import Terminal, { type TermLine } from "./Terminal";
import DiffPanel from "./DiffPanel";
import Artifact from "./Artifacts";
import { GovernanceModal, TalkTrackDrawer } from "./Overlays";

export type RunResult = Extract<StreamEvent, { type: "result" }>;

export default function Workbench({ claudeMd, settingsJson }: { claudeMd: string; settingsJson: string }) {
  const [mode, setMode] = useState<Mode>("safe");
  const [lines, setLines] = useState<TermLine[]>([]);
  const [running, setRunning] = useState<ScenarioId | null>(null);
  const [results, setResults] = useState<Partial<Record<ScenarioId, RunResult>>>({});
  const [selected, setSelected] = useState<ScenarioId | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [govOpen, setGovOpen] = useState(false);
  const [talkOpen, setTalkOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const seq = useRef(0);
  const liveAvailable = useRef(false);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((s) => {
        liveAvailable.current = !!s.live?.available;
        if (liveAvailable.current) setMode("live");
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(() => setElapsed(Date.now() - startedAt), 100);
    return () => clearInterval(t);
  }, [startedAt]);

  const push = useCallback((tag: LogTag, text: string) => {
    setLines((prev) => [...prev, { id: seq.current++, tag, text }]);
  }, []);

  const run = useCallback(
    async (id: ScenarioId) => {
      if (running) return;
      setRunning(id);
      setSelected(id);
      setLines([]);
      const requested: Mode = liveAvailable.current ? "live" : "safe";
      setMode(requested);
      const t0 = Date.now();
      setStartedAt(t0);
      setElapsed(0);
      try {
        const res = await fetch("/api/run-scenario", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scenarioId: id, mode: requested }),
        });
        if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const raw = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!raw.trim()) continue;
            const ev = JSON.parse(raw) as StreamEvent;
            if (ev.type === "log") push(ev.tag, ev.text);
            else if (ev.type === "mode") {
              setMode(ev.mode);
              push("guard", `Deterministic Safe Mode engaged (${ev.reason})`);
            } else if (ev.type === "result") {
              setResults((r) => ({ ...r, [ev.scenarioId]: ev }));
            }
            else if (ev.type === "error") push("fail", `error: ${ev.message}`);
          }
        }
      } catch (e) {
        push("fail", `Run failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setRunning(null);
        setStartedAt(null);
        setElapsed(Date.now() - t0);
      }
    },
    [push, running],
  );

  const reset = useCallback(async () => {
    if (running) return;
    setResetting(true);
    await fetch("/api/reset", { method: "POST" }).catch(() => undefined);
    setLines([]);
    setResults({});
    setSelected(null);
    setElapsed(0);
    setResetting(false);
  }, [running]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
      if (e.key === "?") setTalkOpen((o) => !o);
      else if (e.key === "Escape") {
        setTalkOpen(false);
        setGovOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shown = selected ? results[selected] : undefined;
  const nextId = SCENARIOS.find((s) => !results[s.id])?.id;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Header */}
      <header className="flex h-[4.5rem] shrink-0 items-center gap-4 border-b border-black/10 bg-alabaster px-5">
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-charcoal font-serif text-xl font-bold text-terracotta">
            F
          </div>
          <h1 className="whitespace-nowrap font-serif text-[20px] font-bold leading-tight">
            FinTechCo <span className="text-black/30">|</span> Agentic Engineering Workbench
          </h1>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <a
            href="https://fintechco-roi.web.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 whitespace-nowrap rounded-lg border border-black/15 bg-white px-3 py-1.5 text-[12.5px] font-medium hover:bg-oat"
          >
            ROI Calculator <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <button onClick={() => setGovOpen(true)} className="whitespace-nowrap rounded-lg border border-black/15 bg-white px-3 py-1.5 text-[12.5px] font-medium hover:bg-oat">
            Governance
          </button>
          <button
            onClick={reset}
            disabled={!!running}
            className="flex items-center gap-1 whitespace-nowrap rounded-lg bg-slate px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            <RotateCcw className={`h-4 w-4 ${resetting ? "animate-spin" : ""}`} /> Reset Workspace
          </button>
        </div>
      </header>

      {/* Workbench */}
      <main className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_minmax(0,1.15fr)] gap-3 bg-alabaster p-3">
        {/* Left: scenarios */}
        <section className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
          {SCENARIOS.map((s) => {
            const r = results[s.id];
            const isRunning = running === s.id;
            const isNext = !running && nextId === s.id;
            return (
              <div
                key={s.id}
                onClick={() => r && setSelected(s.id)}
                className={`rounded-xl border bg-oat p-3.5 transition ${selected === s.id ? "border-terracotta shadow-[0_0_0_2px_rgba(217,119,87,0.25)]" : "border-black/5"} ${r ? "cursor-pointer" : ""}`}
              >
                <div className="font-mono text-[10.5px] uppercase tracking-wide text-black/55">{s.team}</div>
                <h2 className="mt-1 font-serif text-[16px] font-bold leading-snug">{s.title}</h2>
                <p className="mt-1 text-[12px] leading-snug text-black/65">{s.details}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {s.targets.map((f) => (
                    <span key={f} className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[10.5px] text-slate">
                      {f}
                    </span>
                  ))}
                </div>
                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      run(s.id);
                    }}
                    disabled={!!running}
                    className={`flex items-center gap-1.5 rounded-lg bg-terracotta px-3.5 py-2 text-[13px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60 ${isNext ? "ring-2 ring-terracotta/40 ring-offset-2 ring-offset-oat" : ""}`}
                  >
                    {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-white" />}
                    {isRunning ? "Running…" : r ? "Run Again" : "Run Claude Code"}
                  </button>
                  {r && (
                    <span className={`flex items-center gap-1 font-mono text-[11px] ${r.pytest.ok ? "text-sage" : "text-red-700"}`}>
                      <CheckCircle2 className="h-4 w-4" /> {r.pytest.passed}/{r.pytest.total} passed
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        {/* Center: terminal */}
        <Terminal lines={lines} running={!!running} elapsedMs={elapsed} mode={mode} />

        {/* Right: diff + artifact */}
        <section className="flex min-h-0 flex-col gap-3">
          <DiffPanel key={shown?.scenarioId ?? 0} result={shown} />
          <Artifact result={shown} />
        </section>
      </main>

      <GovernanceModal open={govOpen} onClose={() => setGovOpen(false)} claudeMd={claudeMd} settingsJson={settingsJson} />
      <TalkTrackDrawer open={talkOpen} onClose={() => setTalkOpen(false)} />
    </div>
  );
}
