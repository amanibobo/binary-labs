import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { previewEnv } from "@/env";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";
import { receiveVideoPart, videoPartUrl } from "@/lib/video-upload";
import { PartTargetRequest, VideoUploadId } from "@/lib/videos";

const PartNumber = z.coerce.number().int().min(1).max(10_000);

async function params(ctx: RouteContext<"/api/videos/uploads/[id]/parts/[n]">) {
  const { id, n } = await ctx.params;
  const uploadId = VideoUploadId.safeParse(id);
  const partNumber = PartNumber.safeParse(n);
  return uploadId.success && partNumber.success ? { uploadId: uploadId.data, partNumber: partNumber.data } : null;
}

// POST answers where part n goes.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/videos/uploads/[id]/parts/[n]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const at = await params(ctx);
  if (at === null) return NextResponse.json({ error: "invalid part" }, { status: 400 });
  const body = PartTargetRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const target = await videoPartUrl(
    access.member.lab.id,
    { uploadId: at.uploadId, storeId: body.data.storeId },
    { partNumber: at.partNumber, size: body.data.size },
  );
  return "url" in target ? ok(target) : NextResponse.json({ error: target.error }, { status: target.status });
}

// PUT takes the part itself, standing in for R2 when the store is a local folder. The part is
// the raw body; proxy.ts skips this path so Next doesn't buffer it.
export async function PUT(request: NextRequest, ctx: RouteContext<"/api/videos/uploads/[id]/parts/[n]">) {
  if (previewEnv().PREVIEW_STORE !== "local") return NextResponse.json({ error: "parts go to the store" }, { status: 404 });
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const at = await params(ctx);
  if (at === null) return NextResponse.json({ error: "invalid part" }, { status: 400 });
  const received = await receiveVideoPart(access.member.lab.id, at.uploadId, at.partNumber, request);
  return "etag" in received
    ? new NextResponse(null, { status: 200, headers: { etag: received.etag } })
    : NextResponse.json({ error: received.error }, { status: received.status });
}
