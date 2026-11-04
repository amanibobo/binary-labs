import { NextResponse, type NextRequest } from "next/server";
import { CorrectionRows } from "@/lib/domain";
import { correctionFailure, correctLabelArgs, CorrectRequest } from "@/lib/labels";
import { logError } from "@/lib/log";
import { readJson, routeAccess } from "@/lib/route-auth";

export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const body = CorrectRequest.safeParse(await readJson(request));
  if (!body.success) return NextResponse.json({ error: "Check the label and try again." }, { status: 400 });

  const { data, error } = await supabase.rpc("correct_label", correctLabelArgs(lab.id, body.data));
  if (error !== null) {
    const failure = correctionFailure(error);
    if (failure.status === 500) logError("labels.correct_failed", { labId: lab.id, error });
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  const result = CorrectionRows.safeParse(data);
  if (!result.success) {
    logError("labels.correct_shape", { labId: lab.id, error: result.error });
    return NextResponse.json({ error: "We couldn't save that. Try again." }, { status: 500 });
  }
  return NextResponse.json(result.data, { headers: { "cache-control": "private, no-store" } });
}
