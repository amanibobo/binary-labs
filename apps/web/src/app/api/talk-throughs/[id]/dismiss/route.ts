import { NextResponse, type NextRequest } from "next/server";
import { TalkThroughId } from "@/lib/ids";
import { logError } from "@/lib/log";
import { ok } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";

// Puts a drafted talk-through aside without using it. The JSON body (empty) is only there so a
// cross-site form can't post here without a preflight.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/talk-throughs/[id]/dismiss">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const id = TalkThroughId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid talk-through id" }, { status: 400 });
  if ((await readJson(request)) === undefined) return NextResponse.json({ error: "expected JSON" }, { status: 415 });

  const { error } = await supabase.rpc("dismiss_talk_through", { p_id: id.data });
  if (error?.code === "BL103") return NextResponse.json({ error: "This draft isn't in your lab." }, { status: 404 });
  if (error !== null) {
    logError("talk_throughs.dismiss_failed", { labId: lab.id, error });
    return NextResponse.json({ error: "We couldn't dismiss that. Try again." }, { status: 500 });
  }
  return ok({ dismissed: true });
}
