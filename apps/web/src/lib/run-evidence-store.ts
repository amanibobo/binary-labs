import "server-only";
import { NextResponse } from "next/server";
import { PlanBodiesJson, PlanChoicesJson, type PlanBodies, type PlanChoice } from "./as-run";
import type { LabId, ProtocolVersionId, RunId } from "./ids";
import { RunJson, type RunRecord } from "./run-record";
import { runError, type RunDb, type Written } from "./run-record-store";
import { EditedFilesJson, type EditedFile } from "./run-originals";
import { unwrap } from "./supabase/server";

// Planned versus actual and the run's edited files (0036), as the member under RLS. Each read
// is null for a run outside the caller's lab.

type DbError = { code?: string; message: string };

const FAILURES: Readonly<Record<string, { status: number; message: string }>> = {
  BL921: { status: 400, message: "That protocol isn't in this lab. Pick another." },
  BL922: { status: 400, message: "That's too long to save. Keep what was done under 200,000 characters." },
};

export function evidenceError(error: DbError, ctx: { event: string; labId: LabId }): NextResponse {
  const failure = FAILURES[error.code ?? ""];
  if (failure === undefined) return runError(error, ctx);
  return NextResponse.json({ error: failure.message }, { status: failure.status, headers: { "cache-control": "private, no-store" } });
}

export async function loadEditedFiles(supabase: RunDb, id: RunId): Promise<EditedFile[] | null> {
  const json = unwrap(await supabase.rpc("run_edited_files", { p_run_id: id }));
  return json === null ? null : EditedFilesJson.parse(json);
}

export async function loadPlanBodies(supabase: RunDb, id: RunId): Promise<PlanBodies | null> {
  const json = unwrap(await supabase.rpc("run_plan_bodies", { p_run_id: id }));
  return json === null ? null : PlanBodiesJson.parse(json);
}

export async function loadPlanChoices(supabase: RunDb, id: RunId, query: string): Promise<PlanChoice[] | null> {
  const json = unwrap(await supabase.rpc("run_plan_choices", { p_run_id: id, p_query: query, p_limit: 12 }));
  return json === null ? null : PlanChoicesJson.parse(json);
}

async function writeRun(call: PromiseLike<{ data: unknown; error: DbError | null }>): Promise<Written<RunRecord>> {
  const { data, error } = await call;
  return error !== null ? { kind: "error", error } : { kind: "ok", value: RunJson.parse(data) };
}

export const setRunPlan = (supabase: RunDb, id: RunId, versionId: ProtocolVersionId | null) =>
  writeRun(supabase.rpc("set_run_plan", { p_run_id: id, p_version_id: versionId }));

export const saveAsRun = (supabase: RunDb, id: RunId, body: string, basedOn: ProtocolVersionId | null) =>
  writeRun(supabase.rpc("save_as_run", { p_run_id: id, p_body: body, p_based_on: basedOn }));
