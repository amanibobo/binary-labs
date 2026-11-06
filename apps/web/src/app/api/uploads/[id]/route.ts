import { NextResponse, type NextRequest } from "next/server";
import { previewEnv } from "@/env";
import { routeAccess } from "@/lib/route-auth";
import { receiveUploadBody } from "@/lib/upload-accept";
import { UploadId } from "@/lib/uploads";

// PUT takes the file itself, standing in for R2's presigned PUT when the store is a local
// folder. The file is the raw body; proxy.ts skips this path so Next doesn't buffer it.
export async function PUT(request: NextRequest, ctx: RouteContext<"/api/uploads/[id]">) {
  if (previewEnv().PREVIEW_STORE !== "local") return NextResponse.json({ error: "files go to the store" }, { status: 404 });
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const uploadId = UploadId.safeParse((await ctx.params).id);
  if (!uploadId.success) return NextResponse.json({ error: "invalid upload id" }, { status: 400 });
  const received = await receiveUploadBody(access.member.lab.id, uploadId.data, request);
  return "stored" in received
    ? new NextResponse(null, { status: 200 })
    : NextResponse.json({ error: received.error }, { status: received.status });
}
