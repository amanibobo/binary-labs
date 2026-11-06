import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ProtocolId, Sha256, TalkThroughId } from "@/lib/ids";
import { logError } from "@/lib/log";
import { ok } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";
import { videoStepsFailure, type VideoSteps } from "@/lib/talk-throughs";

// "Draft steps from this video": starts a talk-through on a video already on the page, or
// answers the one already open for it. The worker drafts once the video's transcript is in.
// The JSON body (empty) is only there so a cross-site form can't post here without a preflight.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/protocols/[id]/videos/[sha]/steps">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const params = await ctx.params;
  const id = ProtocolId.safeParse(params.id);
  const sha = Sha256.safeParse(params.sha);
  if (!id.success || !sha.success) return NextResponse.json({ error: "invalid page or video" }, { status: 400 });
  if ((await readJson(request)) === undefined) return NextResponse.json({ error: "expected JSON" }, { status: 415 });

  const { data, error } = await supabase.rpc("start_video_steps", { p_protocol_id: id.data, p_sha256: sha.data });
  if (error !== null) {
    const known = videoStepsFailure(error.code);
    if (known !== null) return NextResponse.json({ error: known.message }, { status: known.status });
    logError("talk_throughs.video_start_failed", { labId: lab.id, error });
    return NextResponse.json({ error: "We couldn't start drafting steps. Try again." }, { status: 500 });
  }
  const started = z.string().pipe(TalkThroughId).safeParse(data);
  if (!started.success) {
    logError("talk_throughs.video_start_shape", { labId: lab.id, error: started.error });
    return NextResponse.json({ error: "We couldn't start drafting steps. Try again." }, { status: 500 });
  }
  return ok({ talkThroughId: started.data } satisfies VideoSteps);
}
