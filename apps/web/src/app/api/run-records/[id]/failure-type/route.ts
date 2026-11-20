import type { NextRequest } from "next/server";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson } from "@/lib/route-auth";
import { FailureTypeRequest } from "@/lib/run-failure";
import { failureError, setFailureType } from "@/lib/run-failure-store";
import { runAccess } from "@/lib/run-routes";

// POST sets the run's failure type from the fixed list, or clears it (null).
export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/failure-type">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = FailureTypeRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await setFailureType(supabase, access.id, body.data.type);
  if (written.kind === "error") return failureError(written.error, { event: "run.failure_type_failed", labId: lab.id });
  return ok(written.value);
}
