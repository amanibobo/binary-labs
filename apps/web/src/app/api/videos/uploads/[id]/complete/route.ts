import { NextResponse, type NextRequest } from "next/server";
import { badRequest } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";
import { completeVideoUpload } from "@/lib/video-upload";
import { CompleteVideoRequest, VideoUploadId } from "@/lib/videos";

// Joins the parts, checks the video's size and hash here on the server, and records it.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/videos/uploads/[id]/complete">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const uploadId = VideoUploadId.safeParse((await ctx.params).id);
  if (!uploadId.success) return NextResponse.json({ error: "invalid upload id" }, { status: 400 });
  const body = CompleteVideoRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);

  const done = await completeVideoUpload(lab.id, uploadId.data, body.data, async (args) => await supabase.rpc("record_video", args));
  return "receipt" in done
    ? NextResponse.json(done.receipt, { status: done.status })
    : NextResponse.json({ error: done.error }, { status: done.status });
}
