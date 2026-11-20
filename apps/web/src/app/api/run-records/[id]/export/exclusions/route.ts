import type { NextRequest } from "next/server";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson } from "@/lib/route-auth";
import { runAccess } from "@/lib/run-routes";
import { SetExclusionRequest } from "@/lib/task-export";
import { taskError } from "@/lib/task-folder-routes";
import { setExclusion } from "@/lib/task-folder-store";

// An admin adds or removes something the lab leaves out of anything exported. It is the
// lab's list, not this run's; it sits here because the export page is where it is edited.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/export/exclusions">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = SetExclusionRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await setExclusion(supabase, lab.id, body.data);
  if (written.kind === "error") return taskError(written.error, { event: "task.exclusion_failed", labId: lab.id });
  return ok({ exclusions: written.value });
}
