import type { NextRequest } from "next/server";
import { debriefError, loadRunDebrief, startDebrief } from "@/lib/debrief-store";
import { ok } from "@/lib/protocol-routes";
import { runAccess } from "@/lib/run-routes";

// GET is the run's open debrief, else the one last saved to it, else null. POST starts one, or
// answers the one already open.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/debrief">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  return ok({ debrief: await loadRunDebrief(access.member.supabase, access.id) });
}

export async function POST(_request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/debrief">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const written = await startDebrief(supabase, access.id);
  if (written.kind === "error") return debriefError(written.error, { event: "debrief.start_failed", labId: lab.id });
  return ok(written.value);
}
