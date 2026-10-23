import fs from "node:fs";
import path from "node:path";
import Workbench from "@/components/Workbench";

export const dynamic = "force-dynamic";

export default function Page() {
  const seed = path.join(process.cwd(), "seed-workspace");
  const claudeMd = fs.readFileSync(path.join(seed, "CLAUDE.md"), "utf8");
  const settingsJson = fs.readFileSync(path.join(seed, ".claude", "settings.json"), "utf8");
  const hookDir = path.join(seed, ".claude", "hooks");
  const hookFiles: Record<string, string> = Object.fromEntries(
    fs.readdirSync(hookDir).filter((f) => f.endsWith(".py")).map((f) => [f, fs.readFileSync(path.join(hookDir, f), "utf8")]),
  );
  hookFiles["SKILL.md"] = fs.readFileSync(path.join(seed, ".claude", "skills", "architecture-patterns", "SKILL.md"), "utf8");
  const testFiles: Record<string, string> = Object.fromEntries(
    fs.readdirSync(seed).filter((f) => /^test_.*\.py$/.test(f)).map((f) => [f, fs.readFileSync(path.join(seed, f), "utf8")]),
  );
  return <Workbench claudeMd={claudeMd} settingsJson={settingsJson} hookFiles={hookFiles} testFiles={testFiles} />;
}
