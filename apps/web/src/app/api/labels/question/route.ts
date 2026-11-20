import { NextResponse, type NextRequest } from "next/server";
import { LabelRow } from "@/lib/domain";
import { linkFailure, SkipQuestionRequest } from "@/lib/labels";
import { logError } from "@/lib/log";
import { readJson, routeAccess } from "@/lib/route-auth";

// Skips a voice note's question without answering it, or asks it again.
export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const body = SkipQuestionRequest.safeParse(await readJson(request));
  if (!body.success) return NextResponse.json({ error: "Check the question and try again." }, { status: 400 });

  const { data, error } = await supabase.rpc("skip_follow_up", {
    p_lab_id: lab.id,
    p_sha256: body.data.sha256,
    p_skipped: body.data.skipped,
  });
  if (error !== null) {
    const failure = linkFailure(error);
    if (failure.status === 500) logError("labels.skip_failed", { labId: lab.id, error });
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  const label = LabelRow.safeParse(data);
  if (!label.success) {
    logError("labels.skip_shape", { labId: lab.id, error: label.error });
    return NextResponse.json({ error: "We couldn't save that. Try again." }, { status: 500 });
  }
  return NextResponse.json({ label: label.data }, { headers: { "cache-control": "private, no-store" } });
}
