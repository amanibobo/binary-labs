import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { LocationId, ProtocolId } from "@/lib/ids";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";
import { ProtocolVideosRows } from "@/lib/videos";

// GET is the page's videos, polled while any is still on its way.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/protocols/[id]/videos">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const id = ProtocolId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid page id" }, { status: 400 });
  return ok(ProtocolVideosRows.parse(unwrap(await access.member.supabase.rpc("protocol_videos", { p_protocol_id: id.data }))));
}

// DELETE takes a video that hasn't joined the page yet off it. The upload itself stays.
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/protocols/[id]/videos">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const id = ProtocolId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid page id" }, { status: 400 });
  const body = z.object({ locationId: LocationId }).safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  unwrap(
    await access.member.supabase
      .from("pending_protocol_files")
      .delete()
      .eq("protocol_id", id.data)
      .eq("location_id", body.data.locationId),
  );
  return ok({});
}
