import type { NextRequest } from "next/server";
import { ok } from "@/lib/protocol-routes";
import { runAccess } from "@/lib/run-routes";
import { objectStore, taskError } from "@/lib/task-folder-routes";
import { previewTask } from "@/lib/task-folder-store";

// The run's record as it would leave the lab, de-identified, for a person to check. Nothing
// is built or written: this only reads.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/export/preview">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const preview = await previewTask(supabase, objectStore, lab.id, access.id);
  if (preview.kind === "error") return taskError(preview.error, { event: "task.preview_failed", labId: lab.id });
  return ok(preview.value);
}
