import { ensureWorkspace, getLiveStatus, workspaceFor } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bump when shipping UI changes so deploy.sh can confirm the live site is current. */
const APP_VERSION = "per-visitor-1";

export async function GET(req: Request) {
  ensureWorkspace(workspaceFor(req));
  return Response.json({
    version: APP_VERSION,
    revision: process.env.K_REVISION ?? "local",
    live: getLiveStatus(),
  });
}
