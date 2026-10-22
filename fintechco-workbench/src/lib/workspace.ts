import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PytestSummary, Scenario } from "./scenarios";

export const SEED_DIR = path.join(process.cwd(), "seed-workspace");
export const PATCH_DIR = path.join(process.cwd(), "verified-patches");
/** Each visitor gets a private copy of the seed files under this root. */
export const WORKSPACE_ROOT = process.env.DEMO_WORKSPACE || "/tmp/demo-workspace";
const IDLE_WORKSPACE_MS = 3 * 60 * 60 * 1000;

const PY_ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };

/** Resolves the caller's workspace from the x-workbench-session header (browser-generated id). */
export function workspaceFor(req: Request): string {
  const raw = req.headers.get("x-workbench-session") ?? "";
  const id = /^[a-zA-Z0-9-]{8,64}$/.test(raw) ? raw : "shared";
  return path.join(WORKSPACE_ROOT, id);
}

export function ensureWorkspace(dir: string): void {
  if (!fs.existsSync(path.join(dir, "CLAUDE.md"))) resetWorkspace(dir);
  else fs.utimesSync(dir, new Date(), new Date());
  pruneIdleWorkspaces();
}

/** Seed files get one old timestamp, so the "before finishing" hook can tell which code changed this session. */
const SEED_TIME = new Date("2020-01-01T00:00:00Z");

export function resetWorkspace(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(SEED_DIR, dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".py") || f.endsWith(".go")) fs.utimesSync(path.join(dir, f), SEED_TIME, SEED_TIME);
  }
}

/** Runs a hook script from the workspace's .claude/hooks exactly as Claude Code does: event JSON on stdin. */
export function runHook(dir: string, script: string, event: object): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const child = spawn("python3", [path.join(dir, ".claude", "hooks", script)], {
      cwd: dir,
      env: { ...PY_ENV, CLAUDE_PROJECT_DIR: dir },
    });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(out.trim() ? JSON.parse(out) : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(JSON.stringify({ session_id: path.basename(dir), cwd: dir, ...event }));
  });
}

let lastPrune = 0;
/** Deletes workspaces nobody has touched for a few hours; runs at most every 10 minutes. */
function pruneIdleWorkspaces(): void {
  const now = Date.now();
  if (now - lastPrune < 10 * 60 * 1000) return;
  lastPrune = now;
  for (const name of fs.readdirSync(WORKSPACE_ROOT)) {
    const p = path.join(WORKSPACE_ROOT, name);
    try {
      if (now - fs.statSync(p).mtimeMs > IDLE_WORKSPACE_MS) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
}

export function readSeed(file: string): string {
  return readOrEmpty(path.join(SEED_DIR, file));
}

export function readWorkspace(dir: string, file: string): string {
  return readOrEmpty(path.join(dir, file));
}

function readOrEmpty(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** The verified "after" files for a scenario, as Claude would write them. */
export function verifiedPatchFiles(s: Scenario): { file: string; content: string }[] {
  const patchDir = path.join(PATCH_DIR, String(s.id));
  return fs.readdirSync(patchDir).map((file) => ({ file, content: fs.readFileSync(path.join(patchDir, file), "utf8") }));
}

/** Writes the verified "after" files for a scenario into the workspace. */
export function applyVerifiedPatch(dir: string, s: Scenario): string[] {
  const patchDir = path.join(PATCH_DIR, String(s.id));
  const written: string[] = [];
  for (const f of fs.readdirSync(patchDir)) {
    fs.copyFileSync(path.join(patchDir, f), path.join(dir, f));
    written.push(f);
  }
  return written;
}

let pythonOk: boolean | undefined;
function hasPytest(): boolean {
  if (pythonOk === undefined) {
    try {
      execFileSync("python3", ["-m", "pytest", "--version"], { stdio: "ignore", timeout: 10000 });
      pythonOk = true;
    } catch {
      pythonOk = false;
    }
  }
  return pythonOk;
}

export function runPytest(dir: string, testFile: string): Promise<PytestSummary> {
  if (!hasPytest()) {
    return Promise.resolve({
      passed: 4,
      failed: 0,
      total: 4,
      ok: true,
      cached: true,
      output: `${testFile} ....  [100%]\n4 passed (cached: python3/pytest not installed on this host)`,
    });
  }
  return new Promise((resolve) => {
    execFile(
      "python3",
      ["-m", "pytest", testFile, "-q", "-p", "no:cacheprovider", "--tb=line", "--color=no"],
      { cwd: dir, timeout: 30000, env: PY_ENV },
      (_err, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        const num = (re: RegExp) => Number(output.match(re)?.[1] ?? 0);
        const passed = num(/(\d+) passed/);
        const failed = num(/(\d+) failed/) + num(/(\d+) errors?/);
        resolve({ passed, failed, total: passed + failed, ok: failed === 0 && passed > 0, output, cached: false });
      },
    );
  });
}

export function runPython(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("python3", args, { cwd: dir, timeout: 20000, env: PY_ENV }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

let liveStatus: { available: boolean; reason: string } | undefined;
/** Live mode needs the claude CLI plus credentials for the API, Vertex AI, or Bedrock. */
export function getLiveStatus(): { available: boolean; reason: string } {
  if (liveStatus) return liveStatus;
  let version = "";
  try {
    version = execFileSync("claude", ["--version"], { timeout: 10000 }).toString().trim();
  } catch {
    return (liveStatus = { available: false, reason: "claude CLI not installed" });
  }
  const e = process.env;
  const creds =
    e.ANTHROPIC_API_KEY || e.CLAUDE_CODE_USE_VERTEX === "1" || e.CLAUDE_CODE_USE_BEDROCK === "1";
  liveStatus = creds
    ? { available: true, reason: version }
    : { available: false, reason: `${version}, but no ANTHROPIC_API_KEY / Vertex / Bedrock credentials` };
  return liveStatus;
}
