import { type NextRequest } from "next/server";
import { flag, HubsQuery } from "@/lib/map";
import { loadHubView } from "@/lib/map-data";
import { badRequest, ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";

// GET [?similar=1][&tags=1] is the lab map's hubs and how they connect.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const params = request.nextUrl.searchParams;
  const q = HubsQuery.safeParse({ similar: flag(params.get("similar")), tags: flag(params.get("tags")) });
  if (!q.success) return badRequest(q.error);
  return ok(await loadHubView(access.member.supabase, access.member.lab.id, q.data));
}
