import type { NextRequest } from "next/server";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson } from "@/lib/route-auth";
import { LinkRetryRequest } from "@/lib/run-record";
import { linkRetry, loadRetryCandidates, runError } from "@/lib/run-record-store";
import { runAccess } from "@/lib/run-routes";

// GET ?q= is the runs this one might retry. POST links it to one, or unlinks it (null).
export async function GET(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/retry">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const query = (request.nextUrl.searchParams.get("q") ?? "").slice(0, 200);
  return ok({ runs: await loadRetryCandidates(access.member.supabase, access.id, query) });
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/retry">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = LinkRetryRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await linkRetry(supabase, access.id, body.data.retryOf);
  if (written.kind === "error") return runError(written.error, { event: "run.retry_failed", labId: lab.id });
  return ok(written.value);
}
