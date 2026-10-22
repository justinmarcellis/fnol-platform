import { ensureWorkspace, getLiveStatus, WORKSPACE } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureWorkspace();
  return Response.json({ live: getLiveStatus(), workspace: WORKSPACE });
}
