import { ensureWorkspace, getLiveStatus, WORKSPACE } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bump when shipping UI changes so deploy.sh can confirm the live site is current. */
const APP_VERSION = "architectures-2";

export async function GET() {
  ensureWorkspace();
  return Response.json({
    version: APP_VERSION,
    revision: process.env.K_REVISION ?? "local",
    live: getLiveStatus(),
    workspace: WORKSPACE,
  });
}
