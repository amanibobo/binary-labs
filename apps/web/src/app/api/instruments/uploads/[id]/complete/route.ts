import type { NextRequest } from "next/server";
import { asInstrument, badBody, CompleteRequest, INVALID_UPLOAD, jsonBody, StagedUploadId } from "@/lib/instrument-routes";
import { completeUpload } from "@/lib/instrument-upload";

// Joins the parts, checks the file's size and sha256 here on the server, and records it on
// the token's instrument.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/instruments/uploads/[id]/complete">) {
  return asInstrument(request, async (session, db) => {
    const uploadId = StagedUploadId.safeParse((await ctx.params).id);
    if (!uploadId.success) return INVALID_UPLOAD;
    const body = CompleteRequest.safeParse(await jsonBody(request));
    return body.success ? completeUpload(session, uploadId.data, body.data, db) : badBody(body.error);
  });
}
