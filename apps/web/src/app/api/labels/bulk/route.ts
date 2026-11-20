import { NextResponse, type NextRequest } from "next/server";
import { BulkRequest, BulkResultRow, bulkFailure, correctLabelsArgs } from "@/lib/bulk-labels";
import { logError } from "@/lib/log";
import { readJson, routeAccess } from "@/lib/route-auth";

// One change to many files' labels; correct_labels records a correction per file it changes.
export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const body = BulkRequest.safeParse(await readJson(request));
  if (!body.success) return NextResponse.json({ error: "Check the change and try again." }, { status: 400 });

  const { data, error } = await supabase.rpc("correct_labels", correctLabelsArgs(lab.id, body.data));
  if (error !== null) {
    const failure = bulkFailure(error);
    if (failure.status === 500) logError("labels.bulk_failed", { labId: lab.id, error });
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  const result = BulkResultRow.safeParse(data);
  if (!result.success) {
    logError("labels.bulk_shape", { labId: lab.id, error: result.error });
    return NextResponse.json({ error: "We couldn't save that. Try again." }, { status: 500 });
  }
  return NextResponse.json(result.data, { headers: { "cache-control": "private, no-store" } });
}
