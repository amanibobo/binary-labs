import type { NextRequest } from "next/server";
import { z } from "zod";
import { asInstrument, badBody, INVALID_UPLOAD, jsonBody, StagedUploadId, StoreId } from "@/lib/instrument-routes";
import { abortUpload } from "@/lib/instrument-upload";

// Drops the parts sent so far, when the file changed on the instrument PC mid-send.
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/instruments/uploads/[id]">) {
  return asInstrument(request, async (session) => {
    const uploadId = StagedUploadId.safeParse((await ctx.params).id);
    if (!uploadId.success) return INVALID_UPLOAD;
    const body = z.object({ storeId: StoreId }).safeParse(await jsonBody(request));
    if (!body.success) return badBody(body.error);
    return abortUpload(session, { uploadId: uploadId.data, storeId: body.data.storeId });
  });
}
