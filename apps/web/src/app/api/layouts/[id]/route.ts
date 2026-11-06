import { NextResponse, type NextRequest } from "next/server";
import { chartError } from "@/lib/chart-store";
import { LayoutId } from "@/lib/ids";
import { LAYOUT_COLUMNS, LayoutRows, SaveLayoutRequest } from "@/lib/layouts";
import { badRequest, ok, shapeError } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";

// POST saves over a layout (its name, protocol and wells); DELETE removes it. Charts made from
// it keep their own copy.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/layouts/[id]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const id = LayoutId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid layout id" }, { status: 400 });
  const body = SaveLayoutRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const req = body.data;
  const { data, error } = await supabase
    .from("sample_layouts")
    .update({ name: req.name, protocol_id: req.protocolId, layout: req.layout })
    .eq("lab_id", lab.id)
    .eq("id", id.data)
    .select(LAYOUT_COLUMNS);
  if (error !== null) return chartError(error, { event: "layouts.save_failed", labId: lab.id });
  const saved = LayoutRows.safeParse(data);
  if (!saved.success) return shapeError(saved.error, { event: "layouts.save_shape", labId: lab.id });
  const row = saved.data[0];
  if (row === undefined) return NextResponse.json({ error: "That layout is gone." }, { status: 404 });
  return ok(row);
}

export async function DELETE(_request: NextRequest, ctx: RouteContext<"/api/layouts/[id]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const id = LayoutId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid layout id" }, { status: 400 });
  const { error } = await supabase.from("sample_layouts").delete().eq("lab_id", lab.id).eq("id", id.data);
  if (error !== null) return chartError(error, { event: "layouts.delete_failed", labId: lab.id });
  return ok({});
}
