import { NextResponse, type NextRequest } from "next/server";
import { chartError, chartProblem } from "@/lib/chart-store";
import { CHART_COLUMNS, ChartRows, SaveChartRequest, type ChartSaveOutcome } from "@/lib/charts";
import { ChartId } from "@/lib/ids";
import { badRequest, ok, shapeError } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";

// POST saves over the chart, unless someone saved it since the editor opened it (409).
export async function POST(request: NextRequest, ctx: RouteContext<"/api/charts/[id]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const id = ChartId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid chart id" }, { status: 400 });
  const body = SaveChartRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const req = body.data;

  const [chart] = ChartRows.parse(unwrap(await supabase.from("charts").select(CHART_COLUMNS).eq("lab_id", lab.id).eq("id", id.data).limit(1)));
  if (chart === undefined) return NextResponse.json({ error: "That chart is gone." }, { status: 404 });
  const problem = await chartProblem(supabase, lab.id, { sha256: chart.sha256, sheet: req.sheet, spec: req.spec });
  if (problem !== null) return NextResponse.json({ error: problem }, { status: 400 });

  const { data, error } = await supabase
    .from("charts")
    .update({ sheet: req.sheet, title: req.title, spec: req.spec, protocol_id: req.protocolId })
    .eq("id", id.data)
    .eq("updated_at", req.basedOn)
    .select(CHART_COLUMNS);
  if (error !== null) return chartError(error, { event: "charts.save_failed", labId: lab.id });
  const saved = ChartRows.safeParse(data);
  if (!saved.success) return shapeError(saved.error, { event: "charts.save_shape", labId: lab.id });
  const row = saved.data[0];
  if (row === undefined) return NextResponse.json({ kind: "stale" } satisfies ChartSaveOutcome, { status: 409 });
  return ok({ kind: "saved", chart: row } satisfies ChartSaveOutcome);
}

export async function DELETE(_request: NextRequest, ctx: RouteContext<"/api/charts/[id]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const id = ChartId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid chart id" }, { status: 400 });
  const { error } = await supabase.from("charts").delete().eq("lab_id", lab.id).eq("id", id.data);
  if (error !== null) return chartError(error, { event: "charts.delete_failed", labId: lab.id });
  return ok({});
}
