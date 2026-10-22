"use client";

import { useState } from "react";
import { sessionHeaders } from "@/lib/session";
import { BarChart3, CheckCircle2, Loader2, Send, TrendingDown } from "lucide-react";
import type { RunResult } from "./Workbench";

const TITLES: Record<number, string> = {
  1: "Security scorecard",
  2: "Try the fraud check",
  3: "Pull request review",
};

export default function Artifact({ result }: { result?: RunResult }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-termline bg-term">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-termline bg-term2 px-3">
        <BarChart3 className="h-4 w-4 text-[#7d8590]" />
        <span className="whitespace-nowrap font-mono text-[12px] text-[#e6edf3]">Business impact</span>
        {result && <span className="ml-auto truncate font-mono text-[11px] text-terracotta">{TITLES[result.scenarioId]}</span>}
      </div>
      <div className="scroll-dark min-h-0 flex-1 overflow-auto p-4 text-[#c9d1d9]">
        {!result && <p className="font-mono text-[12px] text-[#7d8590]">What this means for the business appears here when the run finishes.</p>}
        {result?.scenarioId === 1 && <SreScorecard result={result} />}
        {result?.scenarioId === 2 && <FraudTester key={result.metrics.durationMs} />}
        {result?.scenarioId === 3 && <PullRequestReview ok={result.pytest.ok} />}
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
        <Tile label="Card-number leaks" value={`${leakSites} → ${ok ? 0 : leakSites}`} sub="Found in two systems" />
        <Tile label="Card-industry rules" value={ok ? "Met" : "Not met"} sub={`${result.pytest.passed} of ${result.pytest.total} checks passed`} />
        <Tile label="Logs" value="Searchable" sub="Consistent, structured format" tone="slate" />
      </div>
      <div className="rounded-lg border border-termline bg-term2 p-3">
        <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-wide text-[#7d8590]">
          <TrendingDown className="h-3.5 w-3.5" /> Expected time to resolve an incident
        </div>
        <Bar label="Today" minutes={42} max={42} color="bg-[#f85149]/70" />
        <Bar label="With Claude Code" minutes={21} max={42} color="bg-sage" />
        <div className="mt-1 text-[11.5px] text-[#8b949e]">
          <b className="text-[#56d364]">Half the time</b> (42 → 21 minutes): consistent logs let the team, and Claude, find the cause faster.
        </div>
      </div>
      <div className="rounded-lg border border-termline bg-term2 p-3 font-mono text-[11px] leading-relaxed">
        <div className="text-[#7d8590]">The same log line, before and after</div>
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
  { label: "$4,500 from overseas, 8th purchase today", amount: 4500, velocity_24h: 8, is_foreign_ip: true },
  { label: "$900 at home, 3rd purchase today", amount: 900, velocity_24h: 3, is_foreign_ip: false },
  { label: "$25 coffee", amount: 25, velocity_24h: 1, is_foreign_ip: false },
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
        headers: sessionHeaders({ "content-type": "application/json" }),
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
          <div className="font-mono text-[10.5px] uppercase tracking-wide text-[#7d8590]">Test a payment</div>
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
              Amount ($)
              <input
                type="number"
                value={req.amount}
                onChange={(e) => setReq({ ...req, label: "custom", amount: Number(e.target.value) })}
                className="rounded border border-termline bg-term px-1.5 py-1 text-[#e6edf3]"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[#7d8590]">
              Purchases in last 24 hours
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
              From an overseas connection
            </label>
          </div>
          <button
            onClick={send}
            disabled={busy}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-terracotta py-1.5 text-[12.5px] font-semibold text-white hover:brightness-105 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Check this payment (${req.amount.toLocaleString("en-US")})
          </button>
        </div>
        <div className="rounded-lg border border-termline bg-term2 p-3 font-mono text-[11.5px]">
          <div className="text-[10.5px] uppercase tracking-wide text-[#7d8590]">Result from the new service</div>
          {!res && <div className="mt-2 text-[#7d8590]">Check a payment to call the service Claude just built. This runs live.</div>}
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
        <Tile label="Time to ship changes" value="35% faster" sub="Target across 120 engineers" tone="terracotta" />
        <Tile label="Experiment to production" value="Weeks → hours" sub="For 40 data scientists" tone="slate" />
        <Tile label="One shared definition" value="Every team" sub="Same inputs and outputs everywhere" />
      </div>
    </div>
  );
}

const FINDINGS = [
  { severity: "Critical", tone: "bg-[#da3633]", line: "Lines 8, 11", what: "Customer input pasted straight into a database query", why: "A crafted order ID could refund every order." },
  { severity: "Critical", tone: "bg-[#da3633]", line: "Line 4", what: "Live payments key written into the code", why: "Anyone with access to the code could see it. Moved to the secure vault." },
  { severity: "High", tone: "bg-[#bd561d]", line: "Line 7", what: "No permission check", why: "Anyone signed in could issue refunds. Now limited to the refunds role." },
  { severity: "Medium", tone: "bg-[#9e6a03]", line: "Line 7", what: "Refunds not limited", why: "A refund could exceed the payment or be issued twice. Both are now blocked." },
];

function PullRequestReview({ ok }: { ok: boolean }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg border border-termline bg-term2 px-3 py-2">
        <span className="font-mono text-[12px] text-[#8b949e]">#1427</span>
        <span className="text-[13px] font-semibold text-[#e6edf3]">Add self-serve refunds for support agents</span>
        <span className="ml-auto flex items-center gap-1.5 text-[12px]">
          <span className="rounded-full bg-[#da3633]/20 px-2 py-0.5 text-[#ff7b72] line-through">Blocked</span>
          <span className="text-[#7d8590]">→</span>
          <span className={`rounded-full px-2 py-0.5 font-semibold text-white ${ok ? "bg-sage" : "bg-[#da3633]"}`}>
            {ok ? "Ready for human review" : "Still blocked"}
          </span>
        </span>
      </div>
      <div className="space-y-1.5">
        {FINDINGS.map((f) => (
          <div key={f.what} className="flex gap-3 rounded-lg border border-termline bg-term2 px-3 py-2">
            <span className={`h-fit shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-bold text-white ${f.tone}`}>{f.severity}</span>
            <div className="min-w-0">
              <div className="text-[12.5px] font-semibold text-[#e6edf3]">
                {f.what} <span className="font-mono text-[11px] font-normal text-[#7d8590]">· {f.line}</span>
              </div>
              <div className="text-[12px] text-[#8b949e]">{f.why}</div>
            </div>
            <CheckCircle2 className="ml-auto h-4 w-4 shrink-0 text-[#56d364]" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        <Tile label="Wait for first review" value="Minutes" sub="Instead of about a day" tone="terracotta" />
        <Tile label="Found before a person looked" value="4 issues" sub="2 critical, all fixed" />
        <Tile label="Time to ship changes" value="35% faster" sub="Target across 120 engineers" tone="slate" />
      </div>
      <p className="text-[11.5px] text-[#7d8590]">
        In practice this runs automatically on every pull request, inside your existing code review. The human reviewer still approves the merge.
      </p>
    </div>
  );
}
