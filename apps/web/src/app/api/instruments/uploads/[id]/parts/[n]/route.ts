import type { NextRequest } from "next/server";
import { previewEnv } from "@/env";
import { asInstrument, badBody, jsonBody, PartNumber, PartTargetRequest, reply, StagedUploadId } from "@/lib/instrument-routes";
import { partUrl, receivePart } from "@/lib/instrument-upload";

type Ctx = RouteContext<"/api/instruments/uploads/[id]/parts/[n]">;

async function params(ctx: Ctx) {
  const { id, n } = await ctx.params;
  const uploadId = StagedUploadId.safeParse(id);
  const partNumber = PartNumber.safeParse(n);
  return uploadId.success && partNumber.success ? { uploadId: uploadId.data, partNumber: partNumber.data } : null;
}

const INVALID_PART = { status: 400, body: { error: "invalid part" } };

// POST answers where part n goes.
export async function POST(request: NextRequest, ctx: Ctx) {
  return asInstrument(request, async (session) => {
    const at = await params(ctx);
    if (at === null) return INVALID_PART;
    const body = PartTargetRequest.safeParse(await jsonBody(request));
    if (!body.success) return badBody(body.error);
    return partUrl(session, { uploadId: at.uploadId, storeId: body.data.storeId }, { partNumber: at.partNumber, size: body.data.size });
  });
}

// PUT takes the part itself, standing in for R2 when the store is a local folder. The part is
// the raw body; proxy.ts skips /api/instruments/ so Next doesn't buffer it.
export async function PUT(request: NextRequest, ctx: Ctx) {
  if (previewEnv().PREVIEW_STORE !== "local") return reply({ status: 404, body: { error: "parts go to the store" } });
  return asInstrument(request, async (session) => {
    const at = await params(ctx);
    return at === null ? INVALID_PART : receivePart(session, at.uploadId, at.partNumber, request);
  });
}
