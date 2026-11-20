import { NextResponse, type NextRequest } from "next/server";
import { logError } from "@/lib/log";
import { ModelCheckRequest, modelCheckFailure } from "@/lib/model-check";
import { loadModelChecks, writeModelCheck } from "@/lib/model-check-store";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson } from "@/lib/route-auth";
import { runAccess, runNotFound } from "@/lib/run-routes";

// GET is the run's model check: the setup, each folder built from the run and its newest
// check. POST starts a check, judges an answer or keeps a task, and answers with all of it
// again. The worker does the sending; nothing here talks to a model.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/model-check">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const checks = await loadModelChecks(access.member.supabase, access.id);
  return checks === null ? runNotFound() : ok(checks);
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/model-check">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = ModelCheckRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await writeModelCheck(supabase, access.id, body.data);
  if (written.kind === "error") {
    const failure = modelCheckFailure(written.error);
    if (failure.status === 500) logError("run.model_check_failed", { labId: lab.id, error: written.error });
    return NextResponse.json({ error: failure.message }, { status: failure.status, headers: { "cache-control": "private, no-store" } });
  }
  return written.value === null ? runNotFound() : ok(written.value);
}
