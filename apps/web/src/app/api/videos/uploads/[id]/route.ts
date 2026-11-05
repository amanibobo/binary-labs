import { NextResponse, type NextRequest } from "next/server";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";
import { abortVideoUpload } from "@/lib/video-upload";
import { PartTargetRequest, VideoUploadId } from "@/lib/videos";

// Cancels an upload and drops the parts already sent.
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/videos/uploads/[id]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const uploadId = VideoUploadId.safeParse((await ctx.params).id);
  if (!uploadId.success) return NextResponse.json({ error: "invalid upload id" }, { status: 400 });
  const body = PartTargetRequest.pick({ storeId: true }).safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  await abortVideoUpload(access.member.lab.id, { uploadId: uploadId.data, storeId: body.data.storeId });
  return ok({});
}
