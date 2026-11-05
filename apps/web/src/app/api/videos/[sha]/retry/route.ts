import { NextResponse, type NextRequest } from "next/server";
import { Sha256 } from "@/lib/ids";
import { ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";

// Sends a video whose transcription failed back to the transcriber.
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/videos/[sha]/retry">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const sha = Sha256.safeParse((await ctx.params).sha);
  if (!sha.success) return NextResponse.json({ error: "invalid video" }, { status: 400 });
  const { supabase, lab } = access.member;
  unwrap(await supabase.rpc("retry_video_transcript", { p_lab_id: lab.id, p_sha256: sha.data }));
  return ok({});
}
