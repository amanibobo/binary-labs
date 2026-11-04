import { NextResponse, type NextRequest } from "next/server";
import { ProtocolId } from "@/lib/ids";
import { badRequest, ok, protocolError } from "@/lib/protocol-routes";
import { FileLinkRequest } from "@/lib/protocols";
import { readJson, routeAccess } from "@/lib/route-auth";

// POST links an indexed file to the page, DELETE unlinks it; both are no-ops when already so.
async function handle(request: NextRequest, ctx: RouteContext<"/api/protocols/[id]/files">, link: boolean) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const id = ProtocolId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid page id" }, { status: 400 });
  const body = FileLinkRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);

  const { error } = link
    ? await supabase.rpc("link_protocol_file", { p_protocol_id: id.data, p_sha256: body.data.sha256 })
    : await supabase.rpc("unlink_protocol_file", { p_protocol_id: id.data, p_sha256: body.data.sha256 });
  if (error !== null) return protocolError(error, { event: "protocols.link_failed", labId: lab.id });
  return ok({});
}

export function POST(request: NextRequest, ctx: RouteContext<"/api/protocols/[id]/files">) {
  return handle(request, ctx, true);
}

export function DELETE(request: NextRequest, ctx: RouteContext<"/api/protocols/[id]/files">) {
  return handle(request, ctx, false);
}
