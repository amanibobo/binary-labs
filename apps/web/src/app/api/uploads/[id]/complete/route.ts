import { NextResponse, type NextRequest } from "next/server";
import { badRequest } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";
import { isTalkThroughUpload } from "@/lib/talk-throughs";
import { completeTalkThrough, completeUpload } from "@/lib/upload-accept";
import { CompleteUploadRequest, UploadId } from "@/lib/uploads";

// A 100 MB recording is read back from R2 and hashed before it's recorded.
export const maxDuration = 120;

// Checks the file that reached the store (its size, and its sha256 against the one the browser
// computed), keeps it under the lab's prefix and records it. What the file is rides in the
// same headers as before; a talk-through is marked by its x-upload-purpose header.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/uploads/[id]/complete">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const uploadId = UploadId.safeParse((await ctx.params).id);
  if (!uploadId.success) return NextResponse.json({ error: "invalid upload id" }, { status: 400 });
  const claim = CompleteUploadRequest.safeParse(await readJson(request));
  if (!claim.success) return badRequest(claim.error);

  const req = { headers: request.headers, claim: claim.data };
  const done = isTalkThroughUpload(request.headers)
    ? await completeTalkThrough(lab.id, uploadId.data, req, async (args) => await supabase.rpc("record_talk_through", args))
    : await completeUpload(
        lab.id,
        uploadId.data,
        req,
        async (args) => await supabase.rpc("record_upload", args),
        async (locationId, batch) => {
          const { error } = await supabase.rpc("tag_upload_batch", { p_location_id: locationId, p_batch_id: batch });
          if (error !== null) throw new Error(error.message);
        },
      );
  return "receipt" in done
    ? NextResponse.json(done.receipt, { status: done.status })
    : NextResponse.json({ error: done.error }, { status: done.status });
}
