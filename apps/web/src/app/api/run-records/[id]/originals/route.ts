import type { NextRequest } from "next/server";
import { ok } from "@/lib/protocol-routes";
import { loadEditedFiles } from "@/lib/run-evidence-store";
import { runAccess, runNotFound } from "@/lib/run-routes";

// GET is the run's files whose place in the lab's folder holds a later version now.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/originals">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const files = await loadEditedFiles(access.member.supabase, access.id);
  return files === null ? runNotFound() : ok({ files });
}
