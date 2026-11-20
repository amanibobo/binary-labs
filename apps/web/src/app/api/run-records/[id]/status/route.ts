import type { NextRequest } from "next/server";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson } from "@/lib/route-auth";
import { SetStatusRequest } from "@/lib/run-record";
import { runError, setRunStatus } from "@/lib/run-record-store";
import { runAccess } from "@/lib/run-routes";

// POST says how the run went. A run with a cause written down answers { kind: "has_causes" }
// instead of leaving failed or odd, until the caller sends clearCauses.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/status">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = SetStatusRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await setRunStatus(supabase, access.id, body.data.status, body.data.clearCauses);
  if (written.kind === "error") return runError(written.error, { event: "run.status_failed", labId: lab.id });
  return ok(written.value);
}
