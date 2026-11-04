import { NextResponse, type NextRequest } from "next/server";
import { TalkThroughId } from "@/lib/ids";
import { loadTalkThrough } from "@/lib/lab-data";
import { logError } from "@/lib/log";
import { ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";

// Polled by the talk-through page while the recording is transcribed and drafted.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/talk-throughs/[id]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const id = TalkThroughId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid talk-through id" }, { status: 400 });
  try {
    const talkThrough = await loadTalkThrough(supabase, id.data);
    if (talkThrough === null) return NextResponse.json({ error: "This recording isn't in your lab." }, { status: 404 });
    return ok(talkThrough);
  } catch (error) {
    logError("talk_throughs.load_failed", { labId: lab.id, error });
    return NextResponse.json({ error: "We couldn't load that recording." }, { status: 500 });
  }
}
