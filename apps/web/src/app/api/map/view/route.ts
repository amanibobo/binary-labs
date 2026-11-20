import { NextResponse, type NextRequest } from "next/server";
import { MapViewSave } from "@/lib/map";
import { saveView } from "@/lib/map-data";
import { badRequest } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";

// POST saves the member's own view of the lab map: its filters and switches, and (from the lab
// map) its camera and open hubs.
export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const body = MapViewSave.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  await saveView(access.member.supabase, access.member.lab.id, body.data);
  return new NextResponse(null, { status: 204 });
}
