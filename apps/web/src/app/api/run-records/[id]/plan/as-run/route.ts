import type { NextRequest } from "next/server";
import { SaveAsRunRequest } from "@/lib/as-run";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson } from "@/lib/route-auth";
import { evidenceError, saveAsRun } from "@/lib/run-evidence-store";
import { runAccess } from "@/lib/run-routes";

// POST saves what was actually done and the version that text started from. An empty text
// clears it.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/plan/as-run">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = SaveAsRunRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await saveAsRun(supabase, access.id, body.data.body, body.data.basedOn);
  if (written.kind === "error") return evidenceError(written.error, { event: "run.as_run_failed", labId: lab.id });
  return ok(written.value);
}
