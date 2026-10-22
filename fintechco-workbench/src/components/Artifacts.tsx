"use client";

import { useState } from "react";
import { BarChart3, CheckCircle2, Loader2, Send, ShieldCheck, TrendingDown } from "lucide-react";
import type { MacroBrief } from "@/lib/scenarios";
import type { RunResult } from "./Workbench";

const TITLES: Record<number, string> = {
  1: "SRE Incident & Compliance Scorecard",
  2: "Interactive Payment Fraud API Contract Tester",
  3: "Federal Reserve Stress-Test · Board Visual Brief",
};

export default function Artifact({ result }: { result?: RunResult }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-termline bg-term">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-termline bg-term2 px-3">
        <BarChart3 className="h-4 w-4 text-[#7d8590]" />
        <span className="whitespace-nowrap font-mono text-[12px] text-[#e6edf3]">Live Business Impact</span>
        {result && <span className="ml-auto truncate font-mono text-[11px] text-terracotta">{TITLES[result.scenarioId]}</span>}
      </div>
      <div className="scroll-dark min-h-0 flex-1 overflow-auto p-4 text-[#c9d1d9]">
        {!result && <p className="font-mono text-[12px] text-[#7d8590]">The business-impact artifact for each scenario renders here when its run completes.</p>}
        {result?.scenarioId === 1 && <SreScorecard result={result} />}
        {result?.scenarioId === 2 && <FraudTester key={result.metrics.durationMs} />}
        {result?.scenarioId === 3 && result.brief && <MacroChart brief={result.brief} />}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, tone = "sage" }: { label: string; value: React.ReactNode; sub?: string; tone?: "sage" | "terracotta" | "slate" }) {
  const color = tone === "sage" ? "text-[#56d364]" : tone === "terracotta" ? "text-terracotta" : "text-[#79c0ff]";
  return (
    <div className="rounded-lg border border-termline bg-term2 p-3">
      <div className="font-mono text-[10.5px] uppercase tracking-wide text-[#7d8590]">{label}</div>
      <div className={`mt-1 font-serif text-[22px] font-bold leading-tight ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-[#8b949e]">{sub}</div>}
    </div>
  );
}

function SreScorecard({ result }: { result: RunResult }) {
  const leakSites = result.files.reduce(
    (n, f) => n + f.before.split("\n").filter((l) => /\blog(ger)?\.\w+\(/.test(l) && /(card|msg)/i.test(l)).length,
    0,
  );
  const ok = result.pytest.ok;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2.5">
        <Tile label="PAN leak sites" value={`${leakSites} → ${ok ? 0 : leakSites}`} sub="1 Python · 2 Go log calls" />
        <Tile label="PCI-DSS 3.4 masking" value={ok ? "Verified" : "Failing"} sub={`pytest ${result.pytest.passed}/${result.pytest.total} · tests untouched`} />
        <Tile label="Log format" value="JSON" sub="Python logging + Go slog" tone="slate" />
      </div>
      <div className="rounded-lg border border-termline bg-term2 p-3">
        <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-wide text-[#7d8590]">
          <TrendingDown className="h-3.5 w-3.5" /> Projected incident MTTR · 20 SREs
        </div>
        <Bar label="Today" minutes={42} max={42} color="bg-[#f85149]/70" />
        <Bar label="With Claude Code" minutes={21} max={42} color="bg-sage" />
        <div className="mt-1 text-[11.5px] text-[#8b949e]">
          <b className="text-[#56d364]">−50% incident triage</b> (42 → 21 min): structured logs are machine-parsable, and Claude triages from them directly.
        </div>
      </div>
      <div className="rounded-lg border border-termline bg-term2 p-3 font-mono text-[11px] leading-relaxed">
        <div className="text-[#7d8590]">gateway timeout log line</div>
        <div className="mt-1 text-[#ffa198]">- [trace=req-9941] Gateway timeout for PAN 4111222233334444 amount=$1250.00</div>
        <div className="text-[#7ee787]">
          + {`{"event": "gateway_timeout", "severity": "ERROR", "trace_id": "req-9941", "pan": "XXXX-XXXX-XXXX-4444", "amount": 1250.0}`}
        </div>
      </div>
    </div>
  );
}

function Bar({ label, minutes, max, color }: { label: string; minutes: number; max: number; color: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 text-[11.5px]">
      <span className="w-28 shrink-0 text-[#8b949e]">{label}</span>
      <div className="h-4 flex-1 rounded bg-white/5">
        <div className={`h-4 rounded ${color}`} style={{ width: `${(minutes / max) * 100}%` }} />
      </div>
      <span className="w-12 text-right font-mono text-[#e6edf3]">{minutes}m</span>
    </div>
  );
}

const PRESETS = [
  { label: "$4,500 · foreign · 8 txns/24h", amount: 4500, velocity_24h: 8, is_foreign_ip: true },
  { label: "$900 · domestic · 3 txns", amount: 900, velocity_24h: 3, is_foreign_ip: false },
  { label: "$25 coffee · domestic", amount: 25, velocity_24h: 1, is_foreign_ip: false },
];

interface ScoreResponse {
  risk_score?: number;
  decision?: string;
  model_version?: string;
  schema_valid?: boolean;
  compute_ms?: number;
  roundtrip_ms?: number;
  error?: string;
}

function FraudTester() {
  const [req, setReq] = useState(PRESETS[0]);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ScoreResponse | null>(null);

  const send = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/fraud-score", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      setRes((await r.json()).response);
    } catch {
      setRes({ error: "request failed", schema_valid: false });
    } finally {
      setBusy(false);
    }
  };

  const decisionColor =
    res?.decision === "DECLINE" ? "text-[#f85149]" : res?.decision === "REVIEW" ? "text-[#e3b341]" : "text-[#56d364]";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[1fr_1fr] gap-3">
        <div className="rounded-lg border border-termline bg-term2 p-3">
          <div className="font-mono text-[10.5px] uppercase tracking-wide text-[#7d8590]">POST /v1/payments/score</div>
          <div className="mt-2 flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => setReq(p)}
                className={`rounded border px-1.5 py-0.5 text-[10.5px] ${req.label === p.label ? "border-terracotta text-terracotta" : "border-termline text-[#8b949e] hover:text-[#c9d1d9]"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[11.5px]">
            <label className="flex flex-col gap-0.5 text-[#7d8590]">
              amount
              <input
                type="number"
                value={req.amount}
                onChange={(e) => setReq({ ...req, label: "custom", amount: Number(e.target.value) })}
                className="rounded border border-termline bg-term px-1.5 py-1 text-[#e6edf3]"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[#7d8590]">
              velocity_24h
              <input
                type="number"
                value={req.velocity_24h}
                onChange={(e) => setReq({ ...req, label: "custom", velocity_24h: Number(e.target.value) })}
                className="rounded border border-termline bg-term px-1.5 py-1 text-[#e6edf3]"
              />
            </label>
            <label className="col-span-2 flex items-center gap-2 text-[#7d8590]">
              <input
                type="checkbox"
                checked={req.is_foreign_ip}
                onChange={(e) => setReq({ ...req, label: "custom", is_foreign_ip: e.target.checked })}
              />
              is_foreign_ip
            </label>
          </div>
          <button
            onClick={send}
            disabled={busy}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-terracotta py-1.5 text-[12.5px] font-semibold text-white hover:brightness-105 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send Test Transaction (${req.amount.toLocaleString("en-US")})
          </button>
        </div>
        <div className="rounded-lg border border-termline bg-term2 p-3 font-mono text-[11.5px]">
          <div className="text-[10.5px] uppercase tracking-wide text-[#7d8590]">Response · executes workspace module</div>
          {!res && <div className="mt-2 text-[#7d8590]">Send a transaction to call the scoring module Claude just refactored.</div>}
          {res && (
            <>
              {res.decision && <div className={`mt-1 font-serif text-[26px] font-bold ${decisionColor}`}>{res.decision}</div>}
              <pre className="mt-1 whitespace-pre-wrap text-[#c9d1d9]">
                {JSON.stringify(
                  {
                    risk_score: res.risk_score,
                    decision: res.decision,
                    model_version: res.model_version,
                    schema_valid: res.schema_valid,
                    ...(res.error ? { error: res.error } : {}),
                  },
                  null,
                  2,
                )}
              </pre>
              <div className="mt-1 flex items-center gap-1 text-[#56d364]">
                {res.schema_valid && <CheckCircle2 className="h-3.5 w-3.5" />}
                {res.compute_ms !== undefined && `scoring ${res.compute_ms.toFixed(2)}ms · round-trip ${res.roundtrip_ms}ms`}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        <Tile label="Lead time for changes" value="−35%" sub="DORA target · 120 SWEs" tone="terracotta" />
        <Tile label="Notebook → API" value="Weeks → Hours" sub="40 Data Scientists" tone="slate" />
        <Tile label="Contract" value="Py · TS · Java" sub="one OpenAPI schema" />
      </div>
    </div>
  );
}

function MacroChart({ brief }: { brief: MacroBrief }) {
  const [hover, setHover] = useState<number | null>(null);
  const rows = brief.rows;
  const W = 640;
  const H = 230;
  const pad = { l: 40, r: 44, t: 14, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const ffMax = 6;
  const dqMin = 0.5;
  const dqMax = 3.25;
  const x = (i: number) => pad.l + (i / (rows.length - 1)) * iw;
  const yFF = (v: number) => pad.t + ih - (v / ffMax) * ih;
  const yDQ = (v: number) => pad.t + ih - ((v - dqMin) / (dqMax - dqMin)) * ih;
  const path = (f: (v: number) => number, key: "fed_funds_rate" | "fintechco_delinquency_rate") =>
    rows.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${f(r[key]).toFixed(1)}`).join(" ");
  const h = hover !== null ? rows[hover] : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-full bg-terracotta px-2.5 py-0.5 font-mono text-[12px] font-bold text-white">
          Pearson r = {brief.r.toFixed(2)}, p {brief.p_value < 0.001 ? "< 0.001" : `= ${brief.p_value.toFixed(3)}`}
        </span>
        <span className="font-mono text-[11px] text-[#8b949e]">n = {brief.n} quarters · +{brief.slope_bp_per_100bp.toFixed(0)}bp per +100bp</span>
        <span className="ml-auto flex items-center gap-3 font-mono text-[11px]">
          <span className="flex items-center gap-1"><i className="inline-block h-0.5 w-4 bg-terracotta" /> FEDFUNDS %</span>
          <span className="flex items-center gap-1"><i className="inline-block h-0.5 w-4 bg-[#58a6ff]" /> Delinquency %</span>
        </span>
      </div>
      <div className="relative rounded-lg border border-termline bg-term2 p-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)}>
          {[0, 2, 4, 6].map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={yFF(v)} y2={yFF(v)} stroke="#30363d" strokeDasharray="2 4" />
              <text x={pad.l - 6} y={yFF(v) + 3} textAnchor="end" fontSize="10" fill="#d97757">{v}%</text>
            </g>
          ))}
          {[1, 2, 3].map((v) => (
            <text key={v} x={W - pad.r + 6} y={yDQ(v) + 3} fontSize="10" fill="#58a6ff">{v.toFixed(1)}%</text>
          ))}
          {rows.map((r, i) =>
            r.quarter.endsWith("Q1") ? (
              <text key={r.quarter} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="#7d8590">
                {r.quarter.slice(0, 4)}
              </text>
            ) : null,
          )}
          <path d={path(yFF, "fed_funds_rate")} fill="none" stroke="#d97757" strokeWidth="2.5" />
          <path d={path(yDQ, "fintechco_delinquency_rate")} fill="none" stroke="#58a6ff" strokeWidth="2.5" />
          {hover !== null && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="#8b949e" strokeDasharray="3 3" />
              <circle cx={x(hover)} cy={yFF(rows[hover].fed_funds_rate)} r="4" fill="#d97757" />
              <circle cx={x(hover)} cy={yDQ(rows[hover].fintechco_delinquency_rate)} r="4" fill="#58a6ff" />
            </>
          )}
          {rows.map((r, i) => (
            <rect
              key={r.quarter}
              x={x(i) - iw / (rows.length - 1) / 2}
              y={pad.t}
              width={iw / (rows.length - 1)}
              height={ih}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {h && (
          <div className="pointer-events-none absolute right-3 top-3 rounded-md border border-termline bg-term px-2.5 py-1.5 font-mono text-[11px]">
            <div className="text-[#e6edf3]">{h.quarter}</div>
            <div className="text-terracotta">Fed Funds {h.fed_funds_rate.toFixed(2)}%</div>
            <div className="text-[#58a6ff]">Delinquency {h.fintechco_delinquency_rate.toFixed(2)}%</div>
            <div className="text-[#8b949e]">Unemployment {h.unemployment_rate.toFixed(1)}%</div>
          </div>
        )}
      </div>
      <div className="rounded-lg border border-termline bg-term2 p-3">
        <div className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wide text-[#7d8590]">
          <ShieldCheck className="h-3.5 w-3.5" /> Board Risk Committee · executive summary
        </div>
        <ul className="mt-1.5 space-y-1.5 text-[12.5px] leading-snug text-[#e6edf3]">
          {brief.bullets.map((b) => (
            <li key={b} className="flex gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-terracotta" />
              {b}
            </li>
          ))}
        </ul>
        <div className="mt-2 font-mono text-[10px] text-[#7d8590]">
          FEDFUNDS: FRED quarterly averages (2025-Q4 onward approximate). Delinquency: synthetic FinTechCo series.
        </div>
      </div>
    </div>
  );
}
