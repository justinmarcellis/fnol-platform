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
  runHook,
  runPython,
  SEED_DIR,
  verifiedPatchFiles,
  workspaceFor,
} from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IDLE_TIMEOUT_MS = Number(process.env.LIVE_IDLE_TIMEOUT_MS || 15000);
const MAX_LIVE_MS = Number(process.env.LIVE_MAX_MS || 150000);

/** Sessions with a run in progress; each visitor has their own workspace. */
const busy = new Set<string>();

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
  const dir = workspaceFor(req);
  if (busy.has(dir)) return Response.json({ error: "a scenario is already running" }, { status: 409 });
  busy.add(dir);

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
        await runScenario(dir, scenario, body.mode === "live" ? "live" : "safe", log, emit, (c) => (child = c));
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        busy.delete(dir);
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

async function runScenario(dir: string, s: Scenario, requested: Mode, log: Log, emit: Emit, setChild: (c: ChildProcess) => void) {
  const t0 = Date.now();
  ensureWorkspace(dir);
  restoreTargets(dir, s);

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
    `Loaded FinTechCo's ${rules} engineering rules and permissions (${settings.permissions.allow.length} actions allowed, ${settings.permissions.deny.length} blocked). Running inside your private cloud.`,
  );
  await pace();
  const start = await runHook(dir, "architecture_context.py", { hook_event_name: "SessionStart" });
  if (start) log("hook", "Session start: FinTechCo's Architecture Patterns skill loaded into Claude's context");
  await pace();

  log("bash", "Running the automated checks before changing anything");
  const baseline = await runPytest(dir, s.testFile);
  log(baseline.ok ? "pass" : "fail", `${baseline.passed} of ${baseline.total || 4} checks pass today${baseline.ok ? "" : ". There is a problem to fix"}`);
  await pace();

  let tokens = s.estTokens;
  let costUsd = s.estTokens * EST_USD_PER_TOKEN;
  let estimated = true;

  if (mode === "live") {
    const live = await runLive(dir, s, log, setChild);
    if (live.ok) {
      tokens = live.tokens;
      costUsd = live.costUsd;
      estimated = false;
    } else {
      mode = "safe";
      emit({ type: "mode", mode, reason: live.reason });
      log("guard", `The live session stopped responding (${live.reason}), so we switched to the recorded version`);
      restoreTargets(dir, s);
      await safeScript(dir, s, log);
    }
  } else {
    await safeScript(dir, s, log);
  }

  log("bash", "Running the automated checks again");
  let pytest = await runPytest(dir, s.testFile);
  streamPytest(pytest, log);

  if (!pytest.ok && !estimated) {
    log("guard", "The live fix didn't pass every check, so we applied the reviewed fix and checked again");
    applyVerifiedPatch(dir, s);
    pytest = await runPytest(dir, s.testFile);
    streamPytest(pytest, log);
  }

  const stop = await runHook(dir, "require_checks.py", { hook_event_name: "Stop", stop_hook_active: false });
  if (stop?.decision === "block") log("hook", `Before finishing: blocked. ${stop.reason}`);
  else if (stop?.systemMessage) log("hook", `Before finishing: ${stop.systemMessage}, so Claude may report the task as done.`);

  const durationMs = Date.now() - t0;
  log(
    "done",
    `Done. Cost of this run: about $${costUsd.toFixed(2)}. No data was kept by the model provider.`,
  );

  emit({
    type: "result",
    scenarioId: s.id,
    mode,
    files: s.targets.map((f) => ({ path: f, before: readSeed(f), after: readWorkspace(dir, f) })),
    baseline,
    pytest,
    metrics: { durationMs, tokens, costUsd, estimated },
  });
}

function restoreTargets(dir: string, s: Scenario) {
  for (const f of s.targets) {
    const seed = path.join(SEED_DIR, f);
    const dest = path.join(dir, f);
    if (fs.existsSync(seed)) fs.copyFileSync(seed, dest);
    else fs.rmSync(dest, { force: true });
  }
}

function streamPytest(p: PytestSummary, log: Log) {
  log(p.ok ? "pass" : "fail", `${p.passed} of ${p.total} checks ${p.ok ? "passed" : "failed"}`);
}

/** Deterministic Safe Mode: real reads, real scans, real file writes, scripted narration. */
async function safeScript(dir: string, s: Scenario, log: Log) {
  for (const f of s.targets) {
    const src = readSeed(f);
    log("read", src ? `${f} (${lineCount(src)} lines)` : `${f} doesn't exist yet, so it will be created`);
    await pace();
  }

  if (s.id === 1) {
    for (const f of s.targets) {
      readSeed(f)
        .split("\n")
        .forEach((line, i) => {
          if (LOG_CALL.test(line) && /(card|msg)/i.test(line)) log("grep", `${f}, line ${i + 1}: a full card number is written to the log`);
        });
    }
    await pace();
    log("reasoning", "Full card numbers are being written to the logs in two places. That breaks the card industry's security rules.");
    await pace();
    log("reasoning", "Plan: show only the last four digits, and write logs in a consistent format the team can search.");
    await pace();
    log("edit", "Tries to add an example log line to sre_payment_worker.py");
    await pace();
    const attempt = await runHook(dir, "block_secrets.py", {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "sre_payment_worker.py", new_string: '# Example log line: "Gateway timeout for PAN 4111 1111 1111 1111"' },
    });
    const denied = (attempt?.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)?.permissionDecisionReason;
    if (denied) {
      log("hook", `Before editing: ${denied}`);
      await pace();
      log("reasoning", "The example itself contained a card number. Using a masked example instead.");
    }
  } else if (s.id === 2) {
    try {
      const out = await runPython(dir, ["-c", "from ds_fraud_notebook import evaluate_transaction_risk as f; print(repr(f(4500, 8, True)))"]);
      log("bash", `Tried the current model on a $4,500 payment: fraud score ${out.trim()}`);
    } catch {
      log("bash", "Tried the current model on a $4,500 payment: fraud score 1.44");
    }
    await pace();
    log("reasoning", "The fraud score came back as 1.44, but a probability can't be above 1. There's also no check on bad inputs.");
    await pace();
    log("reasoning", "Plan: keep the score between 0 and 1, return a clear approve / review / decline decision, reject bad inputs, and publish it as a service.");
  } else {
    readSeed("refund_service.py")
      .split("\n")
      .forEach((line, i) => {
        if (/f"(SELECT|UPDATE)/.test(line)) log("grep", `refund_service.py, line ${i + 1}: the customer's input is pasted straight into a database query`);
        if (/API_KEY = "/.test(line)) log("grep", `refund_service.py, line ${i + 1}: a live payments key is written into the code`);
      });
    await pace();
    log("reasoning", "There's also no check that the person is allowed to issue refunds, and nothing stops a refund bigger than the payment, or a second refund.");
    await pace();
    log("reasoning", "Plan: fix all four, keep the change small, and write review notes so the human reviewer knows what changed and what's left to check.");
    await pace();
    log("reasoning", "Applying the Architecture Patterns skill: parameterized queries, permission check first, guard the amount, secrets from Secret Manager.");
  }
  await pace();

  const patches = verifiedPatchFiles(s);
  const blocked: string[] = [];
  for (const { file, content } of patches) {
    const res = await runHook(dir, "block_secrets.py", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file, content } });
    if (res) blocked.push(file);
  }
  log(
    "hook",
    blocked.length
      ? `Before editing: blocked changes to ${blocked.join(", ")}`
      : `Before editing: scanned ${patches.length} change${patches.length > 1 ? "s" : ""} for card numbers and secrets. Nothing found.`,
  );
  await pace();
  applyVerifiedPatch(dir, s);
  for (const f of s.targets) {
    await runHook(dir, "audit_log.py", { hook_event_name: "PostToolUse", tool_name: readSeed(f) ? "Edit" : "Write", tool_input: { file_path: f } });
    const { added, removed } = diffStats(readSeed(f), readWorkspace(dir, f));
    log("edit", `${readSeed(f) ? "Updated" : "Created"} ${f}: ${added} lines added, ${removed} removed`);
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
function runLive(dir: string, s: Scenario, log: Log, setChild: (c: ChildProcess) => void): Promise<LiveResult> {
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

    const child = spawn("claude", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
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
        log("init", `Live session ${String(ev.session_id).slice(0, 8)} · model ${ev.model} · ${ev.tools?.length ?? 0} tools`);
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
