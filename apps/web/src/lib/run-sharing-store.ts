import "server-only";
import { NextResponse } from "next/server";
import { LabSharingJson, RunSharingJson, SharingLogJson, type LabSharing, type RunSharing, type SharingLogEntry } from "@/components/runs/api/sharing";
import type { LabId, RunId } from "./ids";
import { logError } from "./log";
import { RunJson, runFailure, type RunFailure, type RunRecord } from "./run-record";
import type { RunDb, Written } from "./run-record-store";
import { unwrap } from "./supabase/server";

// Sharing's reads and writes, as the member under RLS. Each is one database function that
// checks the lab, and who in it, itself (0037).

type DbError = { code?: string; message: string };

const FAILURES: Readonly<Record<string, RunFailure>> = {
  BL931: { status: 403, message: "Only the person who ran this run, or an admin, can change its sharing." },
  BL932: { status: 400, message: "This is a demo lab. Its data is made up, so nothing is shared from it." },
  BL933: { status: 400, message: "Read the agreement first, then agree." },
};

export function sharingFailure(error: { code?: string }, scope: "run" | "lab"): RunFailure {
  if (scope === "lab" && error.code === "42501") return { status: 403, message: "Only an admin can do that for the lab." };
  return FAILURES[error.code ?? ""] ?? runFailure(error);
}

export function sharingError(error: DbError, scope: "run" | "lab", ctx: { event: string; labId: LabId }): NextResponse {
  const failure = sharingFailure(error, scope);
  if (failure.status === 500) logError(ctx.event, { labId: ctx.labId, error });
  return NextResponse.json({ error: failure.message }, { status: failure.status, headers: { "cache-control": "private, no-store" } });
}

export async function loadLabSharing(supabase: RunDb, labId: LabId): Promise<LabSharing> {
  return LabSharingJson.parse(unwrap(await supabase.rpc("lab_sharing", { p_lab_id: labId })));
}

// Null when the run isn't the caller's lab's.
export async function loadRunSharing(supabase: RunDb, id: RunId): Promise<RunSharing | null> {
  const json = unwrap(await supabase.rpc("run_sharing", { p_run_id: id }));
  return json === null ? null : RunSharingJson.parse(json);
}

// A run's history for any member; the whole lab's (runId null) for an admin.
export async function loadSharingLog(supabase: RunDb, labId: LabId, runId: RunId | null): Promise<Written<SharingLogEntry[]>> {
  const { data, error } = await supabase.rpc("sharing_log", { p_lab_id: labId, p_run_id: runId, p_limit: 100 });
  return error !== null ? { kind: "error", error } : { kind: "ok", value: SharingLogJson.parse(data) };
}

export async function setRunShare(supabase: RunDb, id: RunId, on: boolean): Promise<Written<RunRecord>> {
  const { data, error } = await supabase.rpc("set_run_share", { p_run_id: id, p_on: on });
  return error !== null ? { kind: "error", error } : { kind: "ok", value: RunJson.parse(data) };
}

export async function setLabShare(supabase: RunDb, labId: LabId, on: boolean, agreement: string): Promise<Written<LabSharing>> {
  const { data, error } = await supabase.rpc("set_lab_share", { p_lab_id: labId, p_on: on, p_agreement: on ? agreement : null });
  return error !== null ? { kind: "error", error } : { kind: "ok", value: LabSharingJson.parse(data) };
}
