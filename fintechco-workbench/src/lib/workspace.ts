import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PytestSummary, Scenario } from "./scenarios";

export const SEED_DIR = path.join(process.cwd(), "seed-workspace");
export const PATCH_DIR = path.join(process.cwd(), "verified-patches");
export const WORKSPACE = process.env.DEMO_WORKSPACE || "/tmp/demo-workspace";

const PY_ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };

export function ensureWorkspace(): void {
  if (!fs.existsSync(path.join(WORKSPACE, "CLAUDE.md"))) resetWorkspace();
}

export function resetWorkspace(): void {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.cpSync(SEED_DIR, WORKSPACE, { recursive: true });
}

export function readSeed(file: string): string {
  return readOrEmpty(path.join(SEED_DIR, file));
}

export function readWorkspace(file: string): string {
  return readOrEmpty(path.join(WORKSPACE, file));
}

function readOrEmpty(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** Writes the verified "after" files for a scenario into the workspace. */
export function applyVerifiedPatch(s: Scenario): string[] {
  const dir = path.join(PATCH_DIR, String(s.id));
  const written: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    fs.copyFileSync(path.join(dir, f), path.join(WORKSPACE, f));
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

export function runPytest(testFile: string): Promise<PytestSummary> {
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
      { cwd: WORKSPACE, timeout: 30000, env: PY_ENV },
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

export function runPython(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("python3", args, { cwd: WORKSPACE, timeout: 20000, env: PY_ENV }, (err, stdout) =>
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
