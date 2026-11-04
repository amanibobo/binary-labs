import { NextResponse, type NextRequest } from "next/server";
import { ProtocolId } from "@/lib/ids";
import { loadProtocolVersion } from "@/lib/lab-data";
import { logError } from "@/lib/log";
import { badRequest, ok, protocolError, shapeError } from "@/lib/protocol-routes";
import { SavedVersionRows, SaveProtocolRequest, saveProtocolArgs, type SaveOutcome } from "@/lib/protocols";
import { readJson, routeAccess } from "@/lib/route-auth";

// The current version, for an editor whose save found someone else got there first.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/protocols/[id]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const id = ProtocolId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid page id" }, { status: 400 });
  try {
    const current = await loadProtocolVersion(supabase, id.data, null);
    if (current === null) return NextResponse.json({ error: "This page isn't in your lab." }, { status: 404 });
    return ok(current);
  } catch (error) {
    logError("protocols.load_failed", { labId: lab.id, error });
    return NextResponse.json({ error: "We couldn't load that page." }, { status: 500 });
  }
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/protocols/[id]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const id = ProtocolId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid page id" }, { status: 400 });
  const body = SaveProtocolRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);

  const { data, error } = await supabase.rpc("save_protocol", saveProtocolArgs(id.data, body.data));
  if (error !== null) return protocolError(error, { event: "protocols.save_failed", labId: lab.id });
  const saved = SavedVersionRows.safeParse(data);
  if (!saved.success) return shapeError(saved.error, { event: "protocols.save_shape", labId: lab.id });
  return ok({ kind: "saved", ...saved.data } satisfies SaveOutcome);
}
