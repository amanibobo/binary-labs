import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { logError } from "@/lib/log";
import { runAccess } from "@/lib/run-routes";
import { REASON_LINES } from "@/lib/task-export";
import { claimExport } from "@/lib/task-folder-gate";
import { objectStore } from "@/lib/task-folder-routes";
import { openTask } from "@/lib/task-folder-store";

const refuse = (status: number, error: string) => NextResponse.json({ error }, { status, headers: { "cache-control": "private, no-store" } });

// Downloads a built task folder. The gate is asked again, a folder whose sharing went off is
// refused, and the bytes come through here (never a link to the store), checked against the
// manifest first.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/export/[exportId]">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const exportId = z.uuid().safeParse((await ctx.params).exportId);
  if (!exportId.success) return refuse(404, "That folder doesn't exist.");
  const opened = await openTask({ db: supabase, store: objectStore, claim: (runId, purpose) => claimExport(supabase, runId, purpose) }, access.id, exportId.data);
  switch (opened.kind) {
    case "blocked":
      return refuse(403, opened.reasons.map((r) => REASON_LINES[r]).join(" "));
    case "withdrawn":
      return refuse(410, "Sharing was turned off for this run after the folder was built, so it can't be downloaded any more.");
    case "missing":
      return refuse(404, "That folder doesn't exist.");
    case "mismatch":
      logError("task.zip_mismatch", { labId: lab.id, runId: access.id, exportId: exportId.data });
      return refuse(500, "The stored folder doesn't match what Binary built, so it wasn't sent.");
    case "ok":
      return new Response(Readable.toWeb(Readable.from(opened.body)) as ReadableStream<Uint8Array>, {
        headers: {
          "content-type": "application/zip",
          "content-length": String(opened.bytes),
          "content-disposition": `attachment; filename="${opened.name}"`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        },
      });
    default: {
      const _exhaustive: never = opened;
      return _exhaustive;
    }
  }
}
