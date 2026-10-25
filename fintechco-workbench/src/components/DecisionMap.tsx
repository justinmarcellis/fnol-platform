"use client";

import { useEffect, useState } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { ASKS, DECISIONS, OUTCOMES } from "@/lib/buildstory";

const W = 940;
const H = 440;
const COL = [220, 470, 780];
const rowY = (i: number, n: number) => 30 + (i * (H - 60)) / Math.max(1, n - 1);

/** A network-style map of how each request led to a decision and an outcome, replayed step by step. */
export default function DecisionMap() {
  const [step, setStep] = useState(-1);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => {
      if (step >= DECISIONS.length - 1) setPlaying(false);
      else setStep(step + 1);
    }, step < 0 ? 300 : 2600);
    return () => clearTimeout(t);
  }, [playing, step]);

  const active = step >= 0 ? DECISIONS[step] : null;
  const seen = (i: number) => step >= i;
  const outcomeLit = (o: number) => DECISIONS.some((d, i) => seen(i) && d.outcomes.includes(o));

  const play = () => {
    if (step >= DECISIONS.length - 1) setStep(-1);
    setPlaying(!playing);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-termline bg-term">
      <div className="flex flex-wrap items-center gap-2 border-b border-termline bg-term2 px-3 py-2">
        <span className="font-mono text-[12px] text-[#e6edf3]">Decision replay</span>
        <span className="font-mono text-[11px] text-[#7d8590]">
          {step < 0 ? "Press play" : `Decision ${step + 1} of ${DECISIONS.length}`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => { setPlaying(false); setStep(Math.max(-1, step - 1)); }} className="rounded p-1.5 text-[#c9d1d9] hover:bg-white/10" aria-label="Previous decision">
            <SkipBack className="h-4 w-4" />
          </button>
          <button onClick={play} className="flex items-center gap-1 rounded-md bg-terracotta px-3 py-1 text-[12px] font-semibold text-white" aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 fill-white" />} {playing ? "Pause" : step >= DECISIONS.length - 1 ? "Replay" : "Play"}
          </button>
          <button onClick={() => { setPlaying(false); setStep(Math.min(DECISIONS.length - 1, step + 1)); }} className="rounded p-1.5 text-[#c9d1d9] hover:bg-white/10" aria-label="Next decision">
            <SkipForward className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="min-w-[640px]">
          {["What you asked for", "What we decided", "What it achieved"].map((t, i) => (
            <text key={t} x={COL[i]} y={14} textAnchor="middle" fontSize="11" fill="#7d8590" fontFamily="ui-monospace, monospace">
              {t.toUpperCase()}
            </text>
          ))}
          {DECISIONS.map((d, i) => {
            const ay = rowY(d.ask, ASKS.length) + 6;
            const dy = rowY(i, DECISIONS.length) + 6;
            const on = step === i;
            const color = on ? "#d97757" : seen(i) ? "#3d6b82" : "#30363d";
            return (
              <g key={i}>
                <line x1={COL[0] + 8} y1={ay} x2={COL[1] - 8} y2={dy} stroke={color} strokeWidth={on ? 2.5 : 1.2} />
                {d.outcomes.map((o) => (
                  <line key={o} x1={COL[1] + 8} y1={dy} x2={COL[2] - 8} y2={rowY(o, OUTCOMES.length) + 6} stroke={color} strokeWidth={on ? 2.5 : 1.2} />
                ))}
              </g>
            );
          })}
          {ASKS.map((a, i) => {
            const on = active?.ask === i;
            return (
              <g key={a} onClick={() => { setPlaying(false); setStep(DECISIONS.findIndex((d) => d.ask === i)); }} className="cursor-pointer">
                <circle cx={COL[0]} cy={rowY(i, ASKS.length) + 6} r={on ? 8 : 6} fill={on ? "#d97757" : seen(i) ? "#3d6b82" : "#30363d"} />
                <text x={COL[0] - 14} y={rowY(i, ASKS.length) + 10} textAnchor="end" fontSize="12" fill={on ? "#ffffff" : "#8b949e"}>
                  {a}
                </text>
              </g>
            );
          })}
          {DECISIONS.map((d, i) => {
            const on = step === i;
            return (
              <g key={d.decision} onClick={() => { setPlaying(false); setStep(i); }} className="cursor-pointer">
                <circle cx={COL[1]} cy={rowY(i, DECISIONS.length) + 6} r={on ? 9 : 6} fill={on ? "#d97757" : seen(i) ? "#3d6b82" : "#30363d"} />
                {on && <circle cx={COL[1]} cy={rowY(i, DECISIONS.length) + 6} r={14} fill="none" stroke="#d97757" strokeOpacity={0.4} />}
                <text x={COL[1] + 14} y={rowY(i, DECISIONS.length) + 10} fontSize="11.5" fill={on ? "#ffffff" : seen(i) ? "#c9d1d9" : "#6e7681"} stroke="#0d1117" strokeWidth={4} paintOrder="stroke">
                  {d.decision}
                </text>
              </g>
            );
          })}
          {OUTCOMES.map((o, i) => {
            const lit = outcomeLit(i);
            const on = active?.outcomes.includes(i);
            return (
              <g key={o}>
                <circle cx={COL[2]} cy={rowY(i, OUTCOMES.length) + 6} r={on ? 10 : 8} fill={on ? "#d97757" : lit ? "#2e6f40" : "#30363d"} />
                <text x={COL[2] + 16} y={rowY(i, OUTCOMES.length) + 10} fontSize="12.5" fill={lit ? "#e6edf3" : "#7d8590"}>
                  {o}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="min-h-[92px] border-t border-termline bg-term2 px-4 py-3">
        {active ? (
          <>
            <div className="font-mono text-[11px] text-terracotta">&ldquo;{ASKS[active.ask]}&rdquo;</div>
            <div className="mt-0.5 text-[15px] font-semibold text-[#e6edf3]">{active.decision}</div>
            <div className="mt-0.5 text-[13px] leading-snug text-[#8b949e]">{active.why}</div>
          </>
        ) : (
          <div className="text-[13px] text-[#8b949e]">
            Every request you made, the decision it led to, and what that decision achieved. Press play to replay them in order, or click any node.
          </div>
        )}
      </div>
    </div>
  );
}
