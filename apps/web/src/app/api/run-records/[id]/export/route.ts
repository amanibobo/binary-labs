import { NextResponse, type NextRequest } from "next/server";
import { logError } from "@/lib/log";
import { ok } from "@/lib/protocol-routes";
import { readJson } from "@/lib/route-auth";
import { runAccess, runNotFound } from "@/lib/run-routes";
import { REASON_LINES, type BuildOutcome } from "@/lib/task-export";
import { objectStore, taskError } from "@/lib/task-folder-routes";
import { buildTask, loadRunTask } from "@/lib/task-folder-store";

const NO_STORE = { "cache-control": "private, no-store" };

// POST exports a run: it builds the run's task folder, de-identified, into the lab's own
// store. The gate is asked first and logs its answer; the database decides again when the
// folder is recorded. A refusal is a 403 that says why ({ kind: "blocked", reasons }), and
// nothing is built or kept.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/export">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  if ((await readJson(request)) === undefined) return NextResponse.json({ error: "Check the page and try again." }, { status: 400 });
  const { supabase, lab } = access.member;
  const built = await buildTask({ db: supabase, store: objectStore }, lab.id, access.id);
  if (built.kind === "error") return taskError(built.error, { event: "task.build_failed", labId: lab.id });
  switch (built.value.kind) {
    case "no_run":
      return runNotFound();
    case "blocked": {
      const { reasons } = built.value;
      return NextResponse.json({ kind: "blocked", reasons, error: reasons.map((r) => REASON_LINES[r]).join(" ") } satisfies BuildOutcome & { error: string }, { status: 403, headers: NO_STORE });
    }
    case "leaks":
      logError("task.leak_check_failed", { labId: lab.id, runId: access.id, parts: built.value.paths.length });
      return NextResponse.json({ error: "Binary couldn't be sure every name was removed, so nothing was built. Tell an admin." }, { status: 500, headers: NO_STORE });
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
