import { NextResponse, type NextRequest } from "next/server";
import { routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";
import { acceptUpload } from "@/lib/upload-accept";
import { MyUploadsRows } from "@/lib/uploads";

// The file is the raw body; proxy.ts skips this path so Next doesn't buffer it in memory.
export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const accepted = await acceptUpload(request, lab.id, async (args) => await supabase.rpc("record_upload", args));
  return "receipt" in accepted
    ? NextResponse.json(accepted.receipt, { status: accepted.status })
    : NextResponse.json({ error: accepted.error }, { status: accepted.status });
}

export async function GET() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const rows = MyUploadsRows.parse(unwrap(await supabase.rpc("my_uploads", { p_lab_id: lab.id })));
  return NextResponse.json(rows, { headers: { "cache-control": "no-store" } });
}
