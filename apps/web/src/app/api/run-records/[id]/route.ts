import type { NextRequest } from "next/server";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson } from "@/lib/route-auth";
import { RunFieldsDraft } from "@/lib/run-record";
import { editRun, loadRun, runError } from "@/lib/run-record-store";
import { runAccess, runNotFound } from "@/lib/run-routes";

// GET is one run, whole. POST changes its name, days, experiment or person.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/run-records/[id]">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const run = await loadRun(access.member.supabase, access.id);
  return run === null ? runNotFound() : ok(run);
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = RunFieldsDraft.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await editRun(supabase, access.id, body.data);
  if (written.kind === "error") return runError(written.error, { event: "run.edit_failed", labId: lab.id });
  return ok(written.value);
}
