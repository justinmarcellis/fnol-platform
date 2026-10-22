import fs from "node:fs";
import path from "node:path";
import Workbench from "@/components/Workbench";

export const dynamic = "force-dynamic";

export default function Page() {
  const seed = path.join(process.cwd(), "seed-workspace");
  const claudeMd = fs.readFileSync(path.join(seed, "CLAUDE.md"), "utf8");
  const settingsJson = fs.readFileSync(path.join(seed, ".claude", "settings.json"), "utf8");
  return <Workbench claudeMd={claudeMd} settingsJson={settingsJson} />;
}
