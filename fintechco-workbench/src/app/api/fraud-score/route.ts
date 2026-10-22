import { ensureWorkspace, runPython } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCRIPT = `
import json, sys, time
from ds_fraud_notebook import evaluate_transaction_risk
a = json.loads(sys.argv[1])
try:
    t = time.perf_counter()
    r = evaluate_transaction_risk(float(a["amount"]), int(a["velocity_24h"]), bool(a["is_foreign_ip"]))
    ms = round((time.perf_counter() - t) * 1000, 3)
    out = dict(r) if isinstance(r, dict) else {"raw_output": r}
    out["compute_ms"] = ms
    print(json.dumps(out))
except ValueError as e:
    print(json.dumps({"error": str(e)}))
`;

/** POST /v1/payments/score stand-in: executes the scoring module currently in /tmp/demo-workspace. */
export async function POST(req: Request) {
  ensureWorkspace();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const payload = {
    amount: Number(body.amount ?? 0),
    velocity_24h: Number(body.velocity_24h ?? 0),
    is_foreign_ip: Boolean(body.is_foreign_ip),
  };
  const t0 = performance.now();
  try {
    const out = JSON.parse(await runPython(["-c", SCRIPT, JSON.stringify(payload)]));
    const roundtrip_ms = Math.round(performance.now() - t0);
    const schema_valid =
      typeof out.risk_score === "number" && out.risk_score >= 0 && out.risk_score <= 1 &&
      ["APPROVE", "REVIEW", "DECLINE"].includes(out.decision);
    return Response.json({ request: payload, response: { ...out, schema_valid, roundtrip_ms } });
  } catch (e) {
    return Response.json({ request: payload, response: { error: e instanceof Error ? e.message.split("\n").pop() : "scoring failed", schema_valid: false } });
  }
}
