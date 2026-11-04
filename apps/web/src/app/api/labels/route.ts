import { NextResponse, type NextRequest } from "next/server";
import { FileLabelRows } from "@/lib/domain";
import { FileLabelsQuery } from "@/lib/labels";
import { logError } from "@/lib/log";
import { routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";

// Labels for the files on screen that had none yet; the results list polls this.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const query = FileLabelsQuery.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: "invalid label parameters" }, { status: 400 });

  try {
    const rows = FileLabelRows.parse(unwrap(await supabase.rpc("file_labels", { p_lab_id: lab.id, p_shas: query.data.shas })));
    return NextResponse.json(rows, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    logError("labels.poll_failed", { labId: lab.id, error });
    return NextResponse.json({ error: "labels failed" }, { status: 500 });
  }
}
