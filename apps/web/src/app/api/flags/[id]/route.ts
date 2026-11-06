import { NextResponse, type NextRequest } from "next/server";
import { flagFailure, ReviewRequest, reviewArgs, ReviewRows } from "@/lib/flags";
import { FlagId } from "@/lib/ids";
import { logError } from "@/lib/log";
import { badRequest, ok, shapeError } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";

// Someone's answer to a flag: useful, wrong or known issue, with an optional note.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/flags/[id]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const id = FlagId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid flag id" }, { status: 400 });
  const body = ReviewRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);

  const { data, error } = await supabase.rpc("review_flag", reviewArgs(id.data, body.data));
  if (error !== null) {
    const failure = flagFailure(error);
    if (failure.status === 500) logError("flags.review_failed", { labId: lab.id, error });
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  const answer = ReviewRows.safeParse(data);
  if (!answer.success) return shapeError(answer.error, { event: "flags.review_shape", labId: lab.id });
  return ok(answer.data);
}
