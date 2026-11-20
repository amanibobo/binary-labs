import { NextResponse, type NextRequest } from "next/server";
import { LabelRow } from "@/lib/domain";
import { linkFailure, RepeatCandidates, RepeatCandidatesQuery, RepeatRequest } from "@/lib/labels";
import { logError } from "@/lib/log";
import { readJson, routeAccess } from "@/lib/route-auth";

// The runs a repeat might repeat, for the picker.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const query = RepeatCandidatesQuery.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: "invalid repeat query" }, { status: 400 });

  const { data, error } = await supabase.rpc("repeat_candidates", {
    p_lab_id: lab.id,
    p_sha256: query.data.sha256,
    p_query: query.data.q,
    p_limit: 8,
  });
  const candidates = RepeatCandidates.safeParse(data);
  if (error !== null || !candidates.success) {
    logError("labels.repeat_candidates_failed", { labId: lab.id, error: error ?? candidates.error });
    return NextResponse.json({ error: "We couldn't list the runs. Try again." }, { status: 500 });
  }
  return NextResponse.json(candidates.data, { headers: { "cache-control": "private, no-store" } });
}

// Links a repeat run to the run it repeats, or unlinks it.
export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const body = RepeatRequest.safeParse(await readJson(request));
  if (!body.success) return NextResponse.json({ error: "Pick a run and try again." }, { status: 400 });

  const { data, error } = await supabase.rpc("link_repeat", {
    p_lab_id: lab.id,
    p_sha256: body.data.sha256,
    p_repeats: body.data.repeatOf,
  });
  if (error !== null) {
    const failure = linkFailure(error);
    if (failure.status === 500) logError("labels.repeat_failed", { labId: lab.id, error });
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  const label = LabelRow.safeParse(data);
  if (!label.success) {
    logError("labels.repeat_shape", { labId: lab.id, error: label.error });
    return NextResponse.json({ error: "We couldn't save that. Try again." }, { status: 500 });
  }
  return NextResponse.json({ label: label.data }, { headers: { "cache-control": "private, no-store" } });
}
