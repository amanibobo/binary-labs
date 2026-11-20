import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { LabId, RunId, Sha256 } from "./ids";
import { logError } from "./log";
import {
  fieldArgs,
  FileRunsJson,
  filterArgs,
  RunJson,
  runFailure,
  RunRefsJson,
  RunRowsJson,
  RunSuggestionsJson,
  RUNS_PAGE,
  type FileRun,
  type NewRunFields,
  type RunFieldsDraft,
  type RunFileRole,
  type RunListFilter,
  type RunRecord,
  type RunRef,
  type RunRow,
  type RunStatus,
  type RunSuggestion,
  type StatusOutcome,
} from "./run-record";
import { unwrap } from "./supabase/server";

// The run record's reads and writes, as the member under RLS. Every write is one database
// function that checks the lab itself; this file only names the arguments and parses what
// comes back. A slice adds its own store beside this one.

type DbError = { code?: string; message: string };
// All this file asks of the member's Supabase client: calling a database function by name.
export type RunDb = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: DbError | null }> };
export type Written<T> = { kind: "ok"; value: T } | { kind: "error"; error: DbError };

async function writeRun(call: PromiseLike<{ data: unknown; error: DbError | null }>): Promise<Written<RunRecord>> {
  const { data, error } = await call;
  return error !== null ? { kind: "error", error } : { kind: "ok", value: RunJson.parse(data) };
}

// A database error from a run function, as the browser should see it.
export function runError(error: DbError, ctx: { event: string; labId: LabId }): NextResponse {
  const failure = runFailure(error);
  if (failure.status === 500) logError(ctx.event, { labId: ctx.labId, error });
  return NextResponse.json({ error: failure.message }, { status: failure.status, headers: { "cache-control": "private, no-store" } });
}

export async function loadRun(supabase: RunDb, id: RunId): Promise<RunRecord | null> {
  const json = unwrap(await supabase.rpc("run_json", { p_run_id: id }));
  return json === null ? null : RunJson.parse(json);
}

export async function loadLabRuns(supabase: RunDb, labId: LabId, filter: RunListFilter, offset: number): Promise<RunRow[]> {
  return RunRowsJson.parse(unwrap(await supabase.rpc("lab_runs", { p_lab_id: labId, p_filter: filterArgs(filter), p_limit: RUNS_PAGE, p_offset: offset })));
}

export async function loadFileRuns(supabase: RunDb, labId: LabId, shas: readonly Sha256[]): Promise<FileRun[]> {
  if (shas.length === 0) return [];
  return FileRunsJson.parse(unwrap(await supabase.rpc("file_runs", { p_lab_id: labId, p_shas: [...new Set(shas)] })));
}

export async function loadRunSuggestions(supabase: RunDb, labId: LabId): Promise<RunSuggestion[]> {
  return RunSuggestionsJson.parse(unwrap(await supabase.rpc("run_suggestions", { p_lab_id: labId, p_limit: 20 })));
}

export async function dismissRunSuggestions(supabase: RunDb, labId: LabId): Promise<void> {
  unwrap(await supabase.rpc("dismiss_run_suggestions", { p_lab_id: labId }));
}

export async function loadRetryCandidates(supabase: RunDb, id: RunId, query: string): Promise<RunRef[]> {
  return RunRefsJson.parse(unwrap(await supabase.rpc("retry_candidates", { p_run_id: id, p_query: query, p_limit: 8 })));
}

export const createRun = (supabase: RunDb, labId: LabId, shas: readonly Sha256[], fields: NewRunFields) =>
  writeRun(supabase.rpc("create_run", { p_lab_id: labId, p_shas: shas, p_fields: fieldArgs(fields) }));

export const editRun = (supabase: RunDb, id: RunId, fields: RunFieldsDraft) =>
  writeRun(supabase.rpc("edit_run", { p_run_id: id, p_fields: fieldArgs(fields) }));

export const addRunFiles = (supabase: RunDb, id: RunId, shas: readonly Sha256[], role: RunFileRole) =>
  writeRun(supabase.rpc("add_run_files", { p_run_id: id, p_shas: shas, p_role: role }));

export const removeRunFile = (supabase: RunDb, id: RunId, sha256: Sha256) =>
  writeRun(supabase.rpc("remove_run_file", { p_run_id: id, p_sha256: sha256 }));

export const linkRetry = (supabase: RunDb, id: RunId, retryOf: RunId | null) =>
  writeRun(supabase.rpc("link_retry", { p_run_id: id, p_retry_of: retryOf }));

// BL906 is the database asking first: the run has a cause that this change would remove.
export async function setRunStatus(supabase: RunDb, id: RunId, status: RunStatus | null, clearCauses: boolean): Promise<Written<StatusOutcome>> {
  const written = await writeRun(supabase.rpc("set_run_status", { p_run_id: id, p_status: status, p_clear_causes: clearCauses }));
  if (written.kind === "ok") return { kind: "ok", value: { kind: "saved", run: written.value } };
  return written.error.code === "BL906" ? { kind: "ok", value: { kind: "has_causes" } } : written;
}

const RunFileRows = z.array(z.object({ sha256: z.string(), original_name: z.string().nullable(), mime: z.string(), kept: z.boolean() }));

// One of a run's files to open as it was read; null when it isn't in the run (or the run
// isn't the caller's lab's).
export async function loadRunFile(supabase: RunDb, id: RunId, sha256: Sha256): Promise<{ originalName: string; mime: string; kept: boolean } | null> {
  const [row] = RunFileRows.parse(unwrap(await supabase.rpc("run_file", { p_run_id: id, p_sha256: sha256 })));
  return row === undefined ? null : { originalName: row.original_name ?? sha256, mime: row.mime, kept: row.kept };
}
