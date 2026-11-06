import { type NextRequest } from "next/server";
import { chartError } from "@/lib/chart-store";
import { LAYOUT_COLUMNS, LayoutRows, SaveLayoutRequest } from "@/lib/layouts";
import { badRequest, ok, shapeError } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";

// The lab's saved plate layouts, newest first (decisions.md, "charts round 1"); POST saves one.
export async function GET() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  return ok(LayoutRows.parse(unwrap(await supabase.from("sample_layouts").select(LAYOUT_COLUMNS).eq("lab_id", lab.id).order("updated_at", { ascending: false }).limit(200))));
}

export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = SaveLayoutRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const req = body.data;
  const { data, error } = await supabase
    .from("sample_layouts")
    .insert({ lab_id: lab.id, name: req.name, protocol_id: req.protocolId, sha256: req.sha256, layout: req.layout })
    .select(LAYOUT_COLUMNS);
  if (error !== null) return chartError(error, { event: "layouts.create_failed", labId: lab.id });
  const saved = LayoutRows.safeParse(data);
  if (!saved.success || saved.data[0] === undefined) return shapeError(saved.error, { event: "layouts.create_shape", labId: lab.id });
  return ok(saved.data[0]);
}
