import type { NextRequest } from "next/server";
import { badRequest, ok, protocolError, shapeError } from "@/lib/protocol-routes";
import { CreateProtocolRequest, createProtocolArgs, SavedVersionRows } from "@/lib/protocols";
import { readJson, routeAccess } from "@/lib/route-auth";

export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const body = CreateProtocolRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);

  const { data, error } = await supabase.rpc("create_protocol", createProtocolArgs(lab.id, body.data));
  if (error !== null) return protocolError(error, { event: "protocols.create_failed", labId: lab.id });
  const saved = SavedVersionRows.safeParse(data);
  if (!saved.success) return shapeError(saved.error, { event: "protocols.create_shape", labId: lab.id });
  return ok(saved.data);
}
