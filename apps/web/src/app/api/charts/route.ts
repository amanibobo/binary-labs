import { NextResponse, type NextRequest } from "next/server";
import { chartError, chartProblem, loadCharts } from "@/lib/chart-store";
import { CHART_COLUMNS, ChartRows, CreateChartRequest } from "@/lib/charts";
import { Sha256 } from "@/lib/ids";
import { badRequest, ok, shapeError } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";

// GET ?sha256= is a file's saved charts, oldest first.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const sha = Sha256.safeParse(request.nextUrl.searchParams.get("sha256"));
  if (!sha.success) return NextResponse.json({ error: "invalid sha256" }, { status: 400 });
  return ok(await loadCharts(access.member.supabase, access.member.lab.id, { kind: "file", sha256: sha.data }));
}

export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = CreateChartRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const req = body.data;

  const problem = await chartProblem(supabase, lab.id, req);
  if (problem !== null) return NextResponse.json({ error: problem }, { status: 400 });

  const { data, error } = await supabase
    .from("charts")
    .insert({ lab_id: lab.id, sha256: req.sha256, sheet: req.sheet, title: req.title, spec: req.spec, protocol_id: req.protocolId })
    .select(CHART_COLUMNS);
  if (error !== null) return chartError(error, { event: "charts.create_failed", labId: lab.id });
  const saved = ChartRows.safeParse(data);
  if (!saved.success || saved.data[0] === undefined) return shapeError(saved.error, { event: "charts.create_shape", labId: lab.id });
  return ok(saved.data[0]);
}
