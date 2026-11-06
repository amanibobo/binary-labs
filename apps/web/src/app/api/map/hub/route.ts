import { NextResponse, type NextRequest } from "next/server";
import { flag, HubQuery } from "@/lib/map";
import { loadHubFiles } from "@/lib/map-data";
import { badRequest, ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";

// GET ?id=<hub>[&similar=1&with=<hub>,<hub>] is one hub's newest files for the lab map, with
// their links.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const params = request.nextUrl.searchParams;
  const q = HubQuery.safeParse({
    id: params.get("id"),
    similar: flag(params.get("similar")),
    with: params.getAll("with"),
  });
  if (!q.success) return badRequest(q.error);
  const files = await loadHubFiles(access.member.supabase, access.member.lab.id, q.data);
  if (files === null) return NextResponse.json({ error: "no such hub in this lab" }, { status: 404 });
  return ok(files);
}
