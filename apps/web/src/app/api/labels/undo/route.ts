import { NextResponse, type NextRequest } from "next/server";
import { CorrectionRows } from "@/lib/domain";
import { correctionFailure, UndoRequest } from "@/lib/labels";
import { logError } from "@/lib/log";
import { readJson, routeAccess } from "@/lib/route-auth";

export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const body = UndoRequest.safeParse(await readJson(request));
  if (!body.success) return NextResponse.json({ error: "There's nothing to undo." }, { status: 400 });

  const { data, error } = await supabase.rpc("undo_correction", { p_correction_id: body.data.correctionId });
  if (error !== null) {
    const failure = correctionFailure(error);
    if (failure.status === 500) logError("labels.undo_failed", { labId: lab.id, error });
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  const result = CorrectionRows.safeParse(data);
  if (!result.success) {
    logError("labels.undo_shape", { labId: lab.id, error: result.error });
    return NextResponse.json({ error: "We couldn't undo that. Try again." }, { status: 500 });
  }
  return NextResponse.json(result.data, { headers: { "cache-control": "private, no-store" } });
}
