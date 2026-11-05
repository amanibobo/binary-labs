import { NextResponse, type NextRequest } from "next/server";
import { chartError, tableState } from "@/lib/chart-store";
import { Sha256 } from "@/lib/ids";
import { ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";

// GET is the file's parsed tables, or how far the worker has got; the chart builder polls it.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/tables/[sha]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const sha = Sha256.safeParse((await ctx.params).sha);
  if (!sha.success) return NextResponse.json({ error: "invalid sha256" }, { status: 400 });
  return ok(await tableState(access.member.supabase, access.member.lab.id, sha.data));
}

// POST asks the worker to read a file's tables: one indexed before charts, or one that failed.
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/tables/[sha]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const sha = Sha256.safeParse((await ctx.params).sha);
  if (!sha.success) return NextResponse.json({ error: "invalid sha256" }, { status: 400 });
  const { error } = await supabase.rpc("request_data_table", { p_lab_id: lab.id, p_sha256: sha.data });
  if (error !== null) return chartError(error, { event: "tables.request_failed", labId: lab.id });
  return ok({});
}
