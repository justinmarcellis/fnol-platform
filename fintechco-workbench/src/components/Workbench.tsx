"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { sessionHeaders } from "@/lib/session";
import { CheckCircle2, ExternalLink, Layers, Loader2, Play, RotateCcw } from "lucide-react";
import { SCENARIOS, type LogTag, type Mode, type ScenarioId, type StreamEvent } from "@/lib/scenarios";
import Terminal, { type TermLine } from "./Terminal";
import DiffPanel from "./DiffPanel";
import Artifact from "./Artifacts";
import { GovernanceModal, TalkTrackDrawer } from "./Overlays";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pause after each line type, tuned so a run plays out in roughly 18 seconds. */
const HOLD_MS: Record<LogTag, number> = {
  cmd: 500,
  init: 500,
  read: 400,
  grep: 350,
  reasoning: 1100,
  edit: 650,
  bash: 500,
  out: 100,
  pass: 800,
  fail: 850,
  guard: 700,
  done: 0,
};

export type RunResult = Extract<StreamEvent, { type: "result" }>;

export default function Workbench({ claudeMd, settingsJson }: { claudeMd: string; settingsJson: string }) {
  const [mode, setMode] = useState<Mode>("safe");
  const [lines, setLines] = useState<TermLine[]>([]);
  const [running, setRunning] = useState<ScenarioId | null>(null);
  const [results, setResults] = useState<Partial<Record<ScenarioId, RunResult>>>({});
  const [selected, setSelected] = useState<ScenarioId | null>(null);
  const [govOpen, setGovOpen] = useState(false);
  const [talkOpen, setTalkOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const seq = useRef(0);
  const liveAvailable = useRef(false);

  useEffect(() => {
    fetch("/api/status", { headers: sessionHeaders() })
      .then((r) => r.json())
      .then((s) => {
        liveAvailable.current = !!s.live?.available;
        if (liveAvailable.current) setMode("live");
      })
      .catch(() => undefined);
  }, []);

  /** Types a line out character by character, then holds so the audience can read it. */
  const typeLine = useCallback(async (tag: LogTag, text: string) => {
    const id = seq.current++;
    const typeMs = tag === "out" ? 0 : Math.min(700, text.length * 7);
    if (typeMs === 0) {
      setLines((prev) => [...prev, { id, tag, text }]);
    } else {
      setLines((prev) => [...prev, { id, tag, text: "" }]);
      const steps = Math.max(1, Math.round(typeMs / 30));
      for (let i = 1; i <= steps; i++) {
        await sleep(30);
        const shown = text.slice(0, Math.ceil((text.length * i) / steps));
        setLines((prev) => prev.map((l) => (l.id === id ? { ...l, text: shown } : l)));
      }
    }
    await sleep(HOLD_MS[tag]);
  }, []);

  const run = useCallback(
    async (id: ScenarioId) => {
      if (running) return;
      setRunning(id);
      setSelected(id);
      setLines([]);
      if (window.innerWidth < 1024) setTimeout(() => document.getElementById("terminal")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
      const requested: Mode = liveAvailable.current ? "live" : "safe";
      setMode(requested);
      // Events are queued and played back at reading pace: Firebase Hosting buffers the
      // stream, so the browser may receive the whole run at once.
      const queue: StreamEvent[] = [];
      let streamDone = false;
      const player = (async () => {
        for (;;) {
          const ev = queue.shift();
          if (!ev) {
            if (streamDone) return;
            await sleep(40);
            continue;
          }
          if (ev.type === "log") await typeLine(ev.tag, ev.text);
          else if (ev.type === "mode") {
            setMode(ev.mode);
            await typeLine("guard", "Running a recorded version of this demo");
          } else if (ev.type === "result") {
            await sleep(400);
            setResults((r) => ({ ...r, [ev.scenarioId]: ev }));
          } else if (ev.type === "error") await typeLine("fail", `error: ${ev.message}`);
        }
      })();
      try {
        const res = await fetch("/api/run-scenario", {
          method: "POST",
          headers: sessionHeaders({ "content-type": "application/json" }),
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
            queue.push(JSON.parse(raw) as StreamEvent);
          }
        }
      } catch (e) {
        queue.push({ type: "error", message: `Run failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        streamDone = true;
        await player;
        setRunning(null);
      }
    },
    [running, typeLine],
  );

  const reset = useCallback(async () => {
    if (running) return;
    setResetting(true);
    await fetch("/api/reset", { method: "POST", headers: sessionHeaders() }).catch(() => undefined);
    setLines([]);
    setResults({});
    setSelected(null);
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
    <div className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      {/* Header */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-black/10 bg-alabaster px-4 py-3 lg:h-[4.5rem] lg:flex-nowrap lg:px-5 lg:py-0">
        <div className="flex min-w-0 items-center gap-3 lg:shrink-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-charcoal font-serif text-xl font-bold text-terracotta">
            F
          </div>
          <h1 className="font-serif text-[17px] font-bold leading-tight sm:text-[20px] lg:whitespace-nowrap">
            FinTechCo <span className="text-black/30">|</span> Agentic Engineering Workbench
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:ml-auto lg:shrink-0 lg:flex-nowrap">
          <Link
            href="/architectures"
            className="flex items-center gap-1 whitespace-nowrap rounded-full bg-charcoal px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:bg-black"
          >
            <Layers className="h-3.5 w-3.5 text-terracotta" /> How it fits together
          </Link>
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
      <main className="grid flex-1 grid-cols-1 gap-3 bg-alabaster p-3 lg:min-h-0 lg:grid-cols-[280px_minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* Left: scenarios */}
        <section className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
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
                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      run(s.id);
                    }}
                    disabled={!!running}
                    className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-terracotta px-3.5 py-2 text-[13px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60 ${isNext ? "ring-2 ring-terracotta/40 ring-offset-2 ring-offset-oat" : ""}`}
                  >
                    {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-white" />}
                    {isRunning ? "Running…" : r ? "Run again" : "Run"}
                  </button>
                  {r && (
                    <span className={`flex items-center gap-1 font-mono text-[11px] ${r.pytest.ok ? "text-sage" : "text-red-700"}`}>
                      <CheckCircle2 className="h-4 w-4" /> {r.pytest.passed} of {r.pytest.total} checks passed
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        {/* Center: terminal */}
        <Terminal lines={lines} running={!!running} mode={mode} />

        {/* Right: diff + artifact */}
        <section className="flex flex-col gap-3 lg:min-h-0">
          <DiffPanel key={shown?.scenarioId ?? 0} result={shown} />
          <Artifact result={shown} />
        </section>
      </main>

      <GovernanceModal open={govOpen} onClose={() => setGovOpen(false)} claudeMd={claudeMd} settingsJson={settingsJson} />
      <TalkTrackDrawer open={talkOpen} onClose={() => setTalkOpen(false)} />
    </div>
  );
}
