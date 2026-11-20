import { NextResponse, type NextRequest } from "next/server";
import { Sha256 } from "@/lib/ids";
import { badRequest, ok } from "@/lib/protocol-routes";
import { loadRunChoices, loadRuns } from "@/lib/run-store";
import { routeAccess } from "@/lib/route-auth";
import { RunsQuery } from "@/lib/runs";

// GET ?sha256=…&sha256=… is those files as runs (name, day, outcome, experiment); GET ?near=
// is what "Add runs" offers beside a file: its experiment's other data sheets, then the lab's
// latest.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const params = request.nextUrl.searchParams;
  const near = params.get("near");
  if (near !== null) {
    const sha = Sha256.safeParse(near);
    if (!sha.success) return NextResponse.json({ error: "invalid sha256" }, { status: 400 });
    return ok(await loadRunChoices(supabase, lab.id, sha.data));
  }
  const query = RunsQuery.safeParse({ sha256: params.getAll("sha256") });
  if (!query.success) return badRequest(query.error);
  return ok(await loadRuns(supabase, lab.id, query.data.sha256));
}
