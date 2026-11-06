import { NextResponse, type NextRequest } from "next/server";
import { badRequest } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";
import { startUpload } from "@/lib/upload-accept";
import { MyUploadsRows, StartUploadRequest } from "@/lib/uploads";

// Starts an upload: checks the type and size, then answers where to PUT the file (a presigned
// R2 URL, or /api/uploads/<id> with the local store). The bytes never pass through here.
export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const body = StartUploadRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const started = await startUpload(access.member.lab.id, body.data);
  return "session" in started
    ? NextResponse.json(started.session, { status: started.status, headers: { "cache-control": "no-store" } })
    : NextResponse.json({ error: started.error }, { status: started.status });
}

export async function GET() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const rows = MyUploadsRows.parse(unwrap(await supabase.rpc("my_uploads", { p_lab_id: lab.id })));
  return NextResponse.json(rows, { headers: { "cache-control": "no-store" } });
}
