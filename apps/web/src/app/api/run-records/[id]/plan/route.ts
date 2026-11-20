import type { NextRequest } from "next/server";
import { SetPlanRequest } from "@/lib/as-run";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson } from "@/lib/route-auth";
import { evidenceError, loadPlanBodies, setRunPlan } from "@/lib/run-evidence-store";
import { runAccess, runNotFound } from "@/lib/run-routes";

// GET is the two texts the page compares. POST picks the protocol version the run was planned
// from, or none (null).
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/plan">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const bodies = await loadPlanBodies(access.member.supabase, access.id);
  return bodies === null ? runNotFound() : ok(bodies);
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/plan">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = SetPlanRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await setRunPlan(supabase, access.id, body.data.versionId);
  if (written.kind === "error") return evidenceError(written.error, { event: "run.plan_failed", labId: lab.id });
  return ok(written.value);
}
