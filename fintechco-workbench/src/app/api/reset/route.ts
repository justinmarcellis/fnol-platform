import { resetWorkspace, workspaceFor } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  resetWorkspace(workspaceFor(req));
  return Response.json({ ok: true });
}
