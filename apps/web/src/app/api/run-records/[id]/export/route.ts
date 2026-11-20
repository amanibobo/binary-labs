import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { blockWords, ShareBlock } from "@/components/runs/api/sharing";
import { askExportGate } from "@/lib/export-gate";
import { readJson } from "@/lib/route-auth";
import { runAccess, runNotFound } from "@/lib/run-routes";

const NO_STORE = { "cache-control": "private, no-store" };

// POST asks to export a run. Only the gate is built: it answers and logs the attempt, and
// nothing is built or sent. A blocked run says why. An allowed one says exporting isn't built
// yet; the grant made for it stays here, unused, and runs out in an hour.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/export">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  if ((await readJson(request)) === undefined) return NextResponse.json({ error: "Check the page and try again." }, { status: 400 });
  const gate = await askExportGate(access.member.supabase, access.id, "export request");
  if (gate.kind === "allowed") {
    return NextResponse.json({ error: "This run can be shared, but exporting isn't built yet. Nothing was sent." }, { status: 501, headers: NO_STORE });
  }
  if (gate.blocks.includes("no_such_run")) return runNotFound();
  const blocks = z.array(ShareBlock).parse(gate.blocks);
  return NextResponse.json({ error: `This run can't be exported: ${blockWords(blocks)}.`, blocks }, { status: 403, headers: NO_STORE });
}
