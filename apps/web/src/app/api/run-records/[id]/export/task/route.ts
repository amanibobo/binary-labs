import type { NextRequest } from "next/server";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson } from "@/lib/route-auth";
import { runAccess, runNotFound } from "@/lib/run-routes";
import { SaveTaskRequest } from "@/lib/task-export";
import { objectStore, taskError } from "@/lib/task-folder-routes";
import { loadRunTask, removeWithdrawn, saveRunTask } from "@/lib/task-folder-store";

// GET is the run's task as its page shows it: what is written, what is missing, the folders
// built. Reading it also takes a withdrawn folder's files out of the store. POST is the
// second scientist saving the question, the rubric and their review.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/export/task">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const task = await loadRunTask(access.member.supabase, access.id);
  if (task === null) return runNotFound();
  return ok(await removeWithdrawn(access.member.supabase, objectStore, task));
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/export/task">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = SaveTaskRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await saveRunTask(supabase, access.id, body.data);
  if (written.kind === "error") return taskError(written.error, { event: "task.save_failed", labId: lab.id });
  return ok(written.value);
}
