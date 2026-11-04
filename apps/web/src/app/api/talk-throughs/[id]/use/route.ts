import { NextResponse, type NextRequest } from "next/server";
import { TalkThroughId } from "@/lib/ids";
import { badRequest, ok, protocolError, shapeError } from "@/lib/protocol-routes";
import { SavedVersionRows, type SaveOutcome } from "@/lib/protocols";
import { readJson, routeAccess } from "@/lib/route-auth";
import { applyFailure, ApplyTalkThroughRequest, applyTalkThroughArgs } from "@/lib/talk-throughs";

// "Use these steps": the reviewed text becomes a new page, or the next version of the page it
// was recorded for, with the recording linked. A stale base answers 409 { kind: "stale" }.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/talk-throughs/[id]/use">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const id = TalkThroughId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid talk-through id" }, { status: 400 });
  const body = ApplyTalkThroughRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);

  const { data, error } = await supabase.rpc("use_talk_through", applyTalkThroughArgs(id.data, body.data));
  if (error !== null) return protocolError(error, { event: "talk_throughs.use_failed", labId: lab.id }, applyFailure);
  const saved = SavedVersionRows.safeParse(data);
  if (!saved.success) return shapeError(saved.error, { event: "talk_throughs.use_shape", labId: lab.id });
  return ok({ kind: "saved", ...saved.data } satisfies SaveOutcome);
}
