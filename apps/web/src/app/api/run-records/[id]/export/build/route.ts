import { NextResponse, type NextRequest } from "next/server";
import { logError } from "@/lib/log";
import { ok } from "@/lib/protocol-routes";
import { runAccess, runNotFound } from "@/lib/run-routes";
import type { BuildOutcome } from "@/lib/task-export";
import { claimExport } from "@/lib/task-folder-gate";
import { objectStore, taskError } from "@/lib/task-folder-routes";
import { buildTask, loadRunTask } from "@/lib/task-folder-store";

// Builds the run's task folder. The gate is asked first, and the database decides again when
// the folder is recorded; a refusal is an answer ({ kind: "blocked" }), written to the run's
// log, never an error.
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/export/build">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const built = await buildTask({ db: supabase, store: objectStore, claim: (runId, purpose) => claimExport(supabase, runId, purpose) }, lab.id, access.id);
  if (built.kind === "error") return taskError(built.error, { event: "task.build_failed", labId: lab.id });
  switch (built.value.kind) {
    case "blocked":
      return ok({ kind: "blocked", reasons: built.value.reasons } satisfies BuildOutcome);
    case "leaks":
      logError("task.leak_check_failed", { labId: lab.id, runId: access.id, parts: built.value.paths.length });
      return NextResponse.json({ error: "Binary couldn't be sure every name was removed, so nothing was built. Tell an admin." }, { status: 500 });
    case "built": {
      const task = await loadRunTask(supabase, access.id);
      return task === null ? runNotFound() : ok({ kind: "built", id: built.value.id, task } satisfies BuildOutcome);
    }
    default: {
      const _exhaustive: never = built.value;
      return _exhaustive;
    }
  }
}
