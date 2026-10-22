import { resetWorkspace, WORKSPACE } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  resetWorkspace();
  return Response.json({ ok: true, workspace: WORKSPACE });
}
