import { NextResponse, type NextRequest } from "next/server";
import { checksFailure, SaveChecksRequest, saveChecksArgs } from "@/lib/checks";
import { ProtocolId } from "@/lib/ids";
import { badRequest, ok, protocolError, shapeError } from "@/lib/protocol-routes";
import { SavedVersionRows, type SaveOutcome } from "@/lib/protocols";
import { readJson, routeAccess } from "@/lib/route-auth";

// Saves the protocol's checks as a new version on top of the one the editor started from.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/protocols/[id]/checks">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const id = ProtocolId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid page id" }, { status: 400 });
  const body = SaveChecksRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);

  const { data, error } = await supabase.rpc("save_checks", saveChecksArgs(id.data, body.data));
  if (error !== null) return protocolError(error, { event: "checks.save_failed", labId: lab.id }, checksFailure);
  const saved = SavedVersionRows.safeParse(data);
  if (!saved.success) return shapeError(saved.error, { event: "checks.save_shape", labId: lab.id });
  return ok({ kind: "saved", ...saved.data } satisfies SaveOutcome);
}
