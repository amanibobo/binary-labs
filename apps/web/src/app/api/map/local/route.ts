import { NextResponse, type NextRequest } from "next/server";
import { depthOf, flag, LocalQuery } from "@/lib/map";
import { loadLocalView } from "@/lib/map-data";
import { badRequest, ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";

// GET ?around=<node>[&depth=2][&similar=1] is the map around one node.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const params = request.nextUrl.searchParams;
  const q = LocalQuery.safeParse({ around: params.get("around"), depth: depthOf(params.get("depth")), similar: flag(params.get("similar")) });
  if (!q.success) return badRequest(q.error);
  const view = await loadLocalView(access.member.supabase, access.member.lab.id, q.data);
  if (view === null) return NextResponse.json({ error: "nothing like that in this lab" }, { status: 404 });
  return ok(view);
}
