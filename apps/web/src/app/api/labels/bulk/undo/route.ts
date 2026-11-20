import { NextResponse, type NextRequest } from "next/server";
import { bulkFailure, UndoBatchRequest, UndoBatchRow } from "@/lib/bulk-labels";
import { logError } from "@/lib/log";
import { readJson, routeAccess } from "@/lib/route-auth";

export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const body = UndoBatchRequest.safeParse(await readJson(request));
  if (!body.success) return NextResponse.json({ error: "There's nothing to undo." }, { status: 400 });

  const { data, error } = await supabase.rpc("undo_label_batch", { p_lab_id: lab.id, p_batch_id: body.data.batchId });
  if (error !== null) {
    const failure = bulkFailure(error);
    if (failure.status === 500) logError("labels.bulk_undo_failed", { labId: lab.id, error });
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  const result = UndoBatchRow.safeParse(data);
  if (!result.success) {
    logError("labels.bulk_undo_shape", { labId: lab.id, error: result.error });
    return NextResponse.json({ error: "We couldn't undo that. Try again." }, { status: 500 });
  }
  return NextResponse.json(result.data, { headers: { "cache-control": "private, no-store" } });
}
