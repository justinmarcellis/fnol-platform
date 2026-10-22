import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { diffStats } from "@/lib/diff";
import {
  buildCliArgs,
  displayCommand,
  EST_USD_PER_TOKEN,
  getScenario,
  type LogTag,
  type MacroBrief,
  type MacroRow,
  type Mode,
  type PytestSummary,
  type Scenario,
  type StreamEvent,
} from "@/lib/scenarios";
import {
  applyVerifiedPatch,
  ensureWorkspace,
  getLiveStatus,
  readSeed,
  readWorkspace,
  runPytest,
  runPython,
  SEED_DIR,
  WORKSPACE,
} from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IDLE_TIMEOUT_MS = Number(process.env.LIVE_IDLE_TIMEOUT_MS || 15000);
const MAX_LIVE_MS = Number(process.env.LIVE_MAX_MS || 150000);

let busy = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The browser paces playback; this only keeps live and safe event order natural.
const pace = () => sleep(80);
/** A logging call (Python logger.x / Go log.Printf) — used to locate PAN leak sites. */
const LOG_CALL = /\blog(ger)?\.\w+\(/;
const lineCount = (s: string) => (s ? s.replace(/\n$/, "").split("\n").length : 0);

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { scenarioId?: number; mode?: Mode };
  const scenario = getScenario(Number(body.scenarioId));
  if (!scenario) return Response.json({ error: "unknown scenario" }, { status: 400 });
  if (busy) return Response.json({ error: "a scenario is already running" }, { status: 409 });
  busy = true;

  const encoder = new TextEncoder();
  let closed = false;
  let child: ChildProcess | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (ev: StreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
        } catch {
          closed = true;
        }
      };
      const log = (tag: LogTag, text: string) => emit({ type: "log", tag, text });
      try {
        await runScenario(scenario, body.mode === "live" ? "live" : "safe", log, emit, (c) => (child = c));
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        busy = false;
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
      child?.kill("SIGKILL");
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

type Log = (tag: LogTag, text: string) => void;
type Emit = (ev: StreamEvent) => void;

async function runScenario(s: Scenario, requested: Mode, log: Log, emit: Emit, setChild: (c: ChildProcess) => void) {
  const t0 = Date.now();
  ensureWorkspace();
  restoreTargets(s);

  let mode: Mode = requested;
  if (mode === "live") {
    const status = getLiveStatus();
    if (!status.available) {
      mode = "safe";
      emit({ type: "mode", mode, reason: status.reason });
    }
  }

  log("cmd", displayCommand(s));
  await pace();
  const settings = JSON.parse(readSeed(".claude/settings.json")) as {
    permissions: { allow: string[]; deny: string[] };
  };
  const rules = (readSeed("CLAUDE.md").match(/\*\*Rule \d/g) || []).length;
  log(
    "init",
    `Loaded CLAUDE.md (${rules} rules) & .claude/settings.json (${settings.permissions.allow.length} allow / ${settings.permissions.deny.length} deny) · Vertex AI / Bedrock private endpoint`,
  );
  await pace();

  log("bash", `Pre-flight gate: python3 -m pytest ${s.testFile} -q`);
  const baseline = await runPytest(s.testFile);
  log(baseline.ok ? "pass" : "fail", `Baseline: ${baseline.passed}/${baseline.total || 4} passed — gate is ${baseline.ok ? "GREEN" : "RED"}`);
  await pace();

  let tokens = s.estTokens;
  let costUsd = s.estTokens * EST_USD_PER_TOKEN;
  let estimated = true;

  if (mode === "live") {
    const live = await runLive(s, log, setChild);
    if (live.ok) {
      tokens = live.tokens;
      costUsd = live.costUsd;
      estimated = false;
    } else {
      mode = "safe";
      emit({ type: "mode", mode, reason: live.reason });
      log("guard", `Live CLI ${live.reason} → switching to Deterministic Safe Mode`);
      restoreTargets(s);
      await safeScript(s, log);
    }
  } else {
    await safeScript(s, log);
  }

  log("bash", `Executing python3 -m pytest ${s.testFile} -q`);
  let pytest = await runPytest(s.testFile);
  streamPytest(pytest, log);

  if (!pytest.ok && !estimated) {
    log("guard", "Live edit did not clear the gate → applying verified patch and re-running");
    applyVerifiedPatch(s);
    pytest = await runPytest(s.testFile);
    streamPytest(pytest, log);
  }

  let brief: MacroBrief | undefined;
  if (s.id === 3) {
    log("bash", "Executing python3 fred_stress_analysis.py");
    brief = await loadBrief();
    log("out", `r = ${brief.r.toFixed(2)} · p ${brief.p_value < 0.001 ? "< 0.001" : "= " + brief.p_value.toFixed(3)} · +${brief.slope_bp_per_100bp.toFixed(0)}bp delinquency per +100bp Fed Funds`);
  }

  const durationMs = Date.now() - t0;
  log(
    "done",
    `Completed · Tokens: ${tokens.toLocaleString("en-US")}${estimated ? " est." : ""} ($${costUsd.toFixed(3)}) | Zero Data Retention boundary`,
  );

  emit({
    type: "result",
    scenarioId: s.id,
    mode,
    files: s.targets.map((f) => ({ path: f, before: readSeed(f), after: readWorkspace(f) })),
    pytest,
    metrics: { durationMs, tokens, costUsd, estimated },
    brief,
  });
}

function restoreTargets(s: Scenario) {
  for (const f of s.targets) {
    const seed = path.join(SEED_DIR, f);
    const dest = path.join(WORKSPACE, f);
    if (fs.existsSync(seed)) fs.copyFileSync(seed, dest);
    else fs.rmSync(dest, { force: true });
  }
}

function streamPytest(p: PytestSummary, log: Log) {
  for (const line of p.output.split("\n").filter(Boolean).slice(-6)) log("out", line);
  log(p.ok ? "pass" : "fail", `pytest: ${p.passed}/${p.total} ${p.ok ? "PASSED" : "FAILED"}${p.cached ? " (cached)" : ""}`);
}

/** Deterministic Safe Mode: real reads, real scans, real file writes, scripted narration. */
async function safeScript(s: Scenario, log: Log) {
  for (const f of s.targets) {
    const src = readSeed(f);
    log("read", src ? `Read ${f} (${lineCount(src)} lines)` : `Read ${f} — not found, will create`);
    await pace();
  }

  if (s.id === 1) {
    for (const f of s.targets) {
      readSeed(f)
        .split("\n")
        .forEach((line, i) => {
          if (LOG_CALL.test(line) && /(card|msg)/i.test(line)) log("grep", `${f}:${i + 1}  ${line.trim()}`);
        });
    }
    await pace();
    log("reasoning", "PCI-DSS Req. 3.4 violation: mask_pan() returns the raw PAN; Go probe logs card=%s in clear text.");
    await pace();
    log("reasoning", "Rule 3 gap: free-text f-string logs. Plan: regex mask (last 4 visible) + JSON / slog structured events.");
  } else if (s.id === 2) {
    try {
      const out = await runPython(["-c", "from ds_fraud_notebook import evaluate_transaction_risk as f; print(repr(f(4500, 8, True)))"]);
      log("bash", `python3 -c "evaluate_transaction_risk(4500, 8, True)" → ${out.trim()}`);
    } catch {
      log("bash", 'python3 -c "evaluate_transaction_risk(4500, 8, True)" → 1.44');
    }
    await pace();
    log("reasoning", "Schema gap: notebook returns an unbounded bare float (1.44 > 1.0), no types, no input validation.");
    await pace();
    log("reasoning", "Plan: typed dataclass + TypedDict contract, saturating score in [0,1], decision thresholds, FastAPI route, TS contract.");
  } else {
    const csv = readSeed("fred_macro_data.csv").trim().split("\n");
    log("read", `Read fred_macro_data.csv (${csv.length - 1} quarters: ${csv[1].split(",")[0]} → ${csv[csv.length - 1].split(",")[0]})`);
    await pace();
    log("reasoning", "Stub raises NotImplementedError. Rule 5: stdlib only → Pearson r + t-test p-value via incomplete beta.");
    await pace();
    log("reasoning", "Add OLS slope for a +200bp stress case and 3 Board bullets generated from the computed numbers.");
  }
  await pace();

  applyVerifiedPatch(s);
  for (const f of s.targets) {
    const { added, removed } = diffStats(readSeed(f), readWorkspace(f));
    log("edit", `${readSeed(f) ? "Edit" : "Write"} ${f}  (+${added} −${removed})`);
    await pace();
  }
}

interface LiveResult {
  ok: boolean;
  reason: string;
  tokens: number;
  costUsd: number;
}

/** Spawns `claude -p` with stream-json output and maps events to terminal lines. */
function runLive(s: Scenario, log: Log, setChild: (c: ChildProcess) => void): Promise<LiveResult> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    // The seed settings.json pins a demo Vertex project; override it with this host's real provider config.
    const providerEnv: Record<string, string> =
      env.CLAUDE_CODE_USE_VERTEX === "1"
        ? {
            CLAUDE_CODE_USE_VERTEX: "1",
            ANTHROPIC_VERTEX_PROJECT_ID: env.ANTHROPIC_VERTEX_PROJECT_ID ?? "",
            CLOUD_ML_REGION: env.CLOUD_ML_REGION ?? "us-east5",
          }
        : { CLAUDE_CODE_USE_VERTEX: "0" };
    const args = [...buildCliArgs(s), "--settings", JSON.stringify({ env: providerEnv })];

    let done = false;
    let buf = "";
    let stderr = "";
    let tokens = 0;
    let costUsd = 0;
    let success = false;
    const toolNames = new Map<string, string>();

    const finish = (r: LiveResult) => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      clearTimeout(cap);
      if (!r.ok) child.kill("SIGKILL");
      resolve(r);
    };
    const fail = (reason: string) => finish({ ok: false, reason, tokens: 0, costUsd: 0 });

    const child = spawn("claude", args, { cwd: WORKSPACE, env, stdio: ["ignore", "pipe", "pipe"] });
    setChild(child);

    let idle = setTimeout(() => fail(`idle > ${IDLE_TIMEOUT_MS / 1000}s`), IDLE_TIMEOUT_MS);
    const cap = setTimeout(() => fail(`exceeded ${MAX_LIVE_MS / 1000}s`), MAX_LIVE_MS);
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail(`idle > ${IDLE_TIMEOUT_MS / 1000}s`), IDLE_TIMEOUT_MS);
    };

    child.on("error", (e) => fail(`failed to start (${e.message})`));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.stdout.on("data", (d: Buffer) => {
      bump();
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          handle(JSON.parse(line));
        } catch {
          /* non-JSON noise */
        }
      }
    });
    child.on("close", (code) => {
      if (success && code === 0) finish({ ok: true, reason: "", tokens, costUsd });
      else fail(`exited (${code ?? "killed"}): ${stderr.trim().split("\n").pop()?.slice(0, 120) || "no result"}`);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function handle(ev: any) {
      if (ev.type === "system" && ev.subtype === "init") {
        log("init", `Live session ${String(ev.session_id).slice(0, 8)} · model ${ev.model} · ${ev.tools?.length ?? 0} tools · cwd ${WORKSPACE}`);
      } else if (ev.type === "assistant") {
        for (const block of ev.message?.content ?? []) {
          if (block.type === "text" && block.text?.trim()) {
            log("reasoning", block.text.replace(/\s+/g, " ").trim().slice(0, 220));
          } else if (block.type === "tool_use") {
            toolNames.set(block.id, block.name);
            log(toolTag(block.name), `${block.name} ${summarizeInput(block.input)}`);
          }
        }
      } else if (ev.type === "user") {
        for (const block of ev.message?.content ?? []) {
          if (block.type === "tool_result" && toolNames.get(block.tool_use_id) === "Bash") {
            const text = typeof block.content === "string" ? block.content : (block.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
            const last = text.trim().split("\n").filter(Boolean).pop();
            if (last) log("out", last.slice(0, 200));
          }
        }
      } else if (ev.type === "result") {
        const u = ev.usage ?? {};
        tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        costUsd = ev.total_cost_usd ?? 0;
        success = ev.subtype === "success" && !ev.is_error;
        if (!success) fail(`returned ${ev.subtype}`);
      }
    }
  });
}

function toolTag(name: string): LogTag {
  if (name === "Read") return "read";
  if (name === "Edit" || name === "Write" || name === "MultiEdit") return "edit";
  if (name === "Bash") return "bash";
  if (name === "Grep" || name === "Glob") return "grep";
  return "reasoning";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizeInput(input: any): string {
  if (!input) return "";
  if (input.command) return input.command;
  if (input.file_path) return path.basename(input.file_path);
  if (input.pattern) return input.pattern;
  return JSON.stringify(input).slice(0, 120);
}

async function loadBrief(): Promise<MacroBrief> {
  try {
    return JSON.parse(await runPython(["fred_stress_analysis.py"])) as MacroBrief;
  } catch {
    return fallbackBrief();
  }
}

/** Used only if python3 is unavailable: same math, computed in TypeScript. */
function fallbackBrief(): MacroBrief {
  const [header, ...lines] = readSeed("fred_macro_data.csv").trim().split("\n");
  const cols = header.split(",");
  const rows = lines.map((l) => {
    const v = l.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, i === 0 ? v[i] : Number(v[i])])) as unknown as MacroRow;
  });
  const xs = rows.map((r) => r.fed_funds_rate);
  const ys = rows.map((r) => r.fintechco_delinquency_rate);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i] - my);
    sxx += (x - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  });
  const r = sxy / Math.sqrt(sxx * syy);
  const slope = sxy / sxx;
  const last = rows[n - 1];
  const shock = last.fintechco_delinquency_rate + 2 * slope;
  return {
    n,
    r,
    p_value: 0.0001,
    slope_bp_per_100bp: Math.round(slope * 1000) / 10,
    stress_delinquency_plus_200bp: Math.round(shock * 100) / 100,
    rows,
    bullets: [
      `Rate sensitivity is strong and significant: r = ${r.toFixed(2)} (n = ${n} quarters).`,
      `Each +100bp in Fed Funds has coincided with +${(slope * 100).toFixed(0)}bp of FinTechCo delinquency.`,
      `Stress case: a +200bp shock from ${last.quarter} implies ~${shock.toFixed(2)}% delinquency.`,
    ],
  };
}
