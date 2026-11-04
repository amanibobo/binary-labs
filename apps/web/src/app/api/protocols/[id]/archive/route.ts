import { NextResponse, type NextRequest } from "next/server";
import { ProtocolId } from "@/lib/ids";
import { ok, protocolError } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";

export async function POST(_request: NextRequest, ctx: RouteContext<"/api/protocols/[id]/archive">) {
  const access = await routeAccess({ admin: true });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const id = ProtocolId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid page id" }, { status: 400 });
  const { error } = await supabase.rpc("archive_protocol", { p_protocol_id: id.data });
  if (error !== null) return protocolError(error, { event: "protocols.archive_failed", labId: lab.id });
  return ok({});
}
