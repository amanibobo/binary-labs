import { NextResponse, type NextRequest } from "next/server";
import { putFile } from "@/lib/object-store";
import { routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";
import { receiveUpload } from "@/lib/upload-receive";
import {
  MyUploadsRows,
  parseUploadHeaders,
  RecordUploadRows,
  refusedKind,
  UPLOAD_MAX_BYTES,
  uploadKey,
  type UploadReceipt,
} from "@/lib/uploads";

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });
const TOO_LARGE = `Files can be up to ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`;

// The file is the raw body; proxy.ts skips this path so Next doesn't buffer it in memory.
export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const meta = parseUploadHeaders(request.headers);
  if (meta === null) return fail(400, "The upload is missing its name or date.");
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  const refused = refusedKind(contentType);
  if (refused !== null) return fail(415, refused);
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (!Number.isSafeInteger(declared) || declared < 0) return fail(411, "The upload needs a Content-Length.");

  const received = await receiveUpload(request.body, { maxBytes: UPLOAD_MAX_BYTES, declaredBytes: declared });
  switch (received.kind) {
    case "too_large":
      return fail(413, TOO_LARGE);
    case "truncated":
      return fail(408, "The upload was cut off. Try again.");
    case "empty":
      return fail(400, "That file is empty.");
    case "received":
      break;
    default: {
      const _exhaustive: never = received;
      return _exhaustive;
    }
  }

  try {
    await putFile(uploadKey(lab.id, received.sha256), received, contentType);
    const { data, error } = await supabase.rpc("record_upload", {
      p_lab_id: lab.id,
      p_sha256: received.sha256,
      p_size: received.size,
      p_name: meta.name,
      p_experiment: meta.experiment,
      p_uploaded_on: meta.uploadedOn,
      p_modified_at: meta.modifiedAt === null ? null : new Date(meta.modifiedAt).toISOString(),
    });
    if (error?.code === "BL201") return fail(413, TOO_LARGE);
    if (error?.code === "22023") return fail(400, error.message);
    const recorded = RecordUploadRows.parse(unwrap({ data, error }));
    const receipt: UploadReceipt = { ...recorded, sha256: received.sha256 };
    return NextResponse.json(receipt, { status: recorded.duplicate ? 200 : 201 });
  } finally {
    await received.cleanup();
  }
}

export async function GET() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const rows = MyUploadsRows.parse(unwrap(await supabase.rpc("my_uploads", { p_lab_id: lab.id })));
  return NextResponse.json(rows, { headers: { "cache-control": "no-store" } });
}
