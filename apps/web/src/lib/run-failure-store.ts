import "server-only";
import { NextResponse } from "next/server";
import type { LabId, PersonId, RunId } from "./ids";
import { logError } from "./log";
import { confirmArgs, ConfirmerChoicesJson, failureFailure, FailureListJson, type ConfirmDraft, type ConfirmerChoice, type FailureList, type FailureType } from "./run-failure";
import { RunJson, type RunRecord } from "./run-record";
import type { RunDb, Written } from "./run-record-store";
import { unwrap } from "./supabase/server";

// The failure record's reads and writes, as the member under RLS. Each write is one database
// function (0035) that checks the run's lab itself; this file names the arguments and parses
// what comes back.

type DbError = { code?: string; message: string };

async function writeRun(call: PromiseLike<{ data: unknown; error: DbError | null }>): Promise<Written<RunRecord>> {
  const { data, error } = await call;
  return error !== null ? { kind: "error", error } : { kind: "ok", value: RunJson.parse(data) };
}

// A failure function's error as the browser should see it (BL91x, else the run record's).
export function failureError(error: DbError, ctx: { event: string; labId: LabId }): NextResponse {
  const failure = failureFailure(error);
  if (failure.status === 500) logError(ctx.event, { labId: ctx.labId, error });
  return NextResponse.json({ error: failure.message }, { status: failure.status, headers: { "cache-control": "private, no-store" } });
}

export async function loadFailureList(supabase: RunDb): Promise<FailureList> {
  return FailureListJson.parse(unwrap(await supabase.rpc("failure_list", {})));
}

export async function loadConfirmerChoices(supabase: RunDb, id: RunId): Promise<ConfirmerChoice[]> {
  return ConfirmerChoicesJson.parse(unwrap(await supabase.rpc("confirmer_choices", { p_run_id: id })));
}

export const setSuspectedCause = (supabase: RunDb, id: RunId, cause: string | null) =>
  writeRun(supabase.rpc("set_suspected_cause", { p_run_id: id, p_cause: cause }));

export const confirmCause = (supabase: RunDb, id: RunId, draft: ConfirmDraft) => writeRun(supabase.rpc("confirm_cause", { p_run_id: id, ...confirmArgs(draft) }));

// A null cause takes the confirmation back; the other arguments are then ignored.
export const withdrawCause = (supabase: RunDb, id: RunId) =>
  writeRun(
    supabase.rpc("confirm_cause", {
      p_run_id: id,
      p_cause: null,
      p_person_id: null,
      p_method: null,
      p_note: null,
      p_confirmed_at: null,
      p_confirm_run: null,
      p_confirm_sha256: null,
    }),
  );

export const attestCause = (supabase: RunDb, id: RunId) => writeRun(supabase.rpc("attest_cause", { p_run_id: id }));

// "This is me" on the run's confirmer (claim_person, 0042), then the run as it reads now.
export async function claimConfirmer(supabase: RunDb, id: RunId, personId: PersonId): Promise<Written<RunRecord>> {
  const { error } = await supabase.rpc("claim_person", { p_person_id: personId });
  return error !== null ? { kind: "error", error } : writeRun(supabase.rpc("run_json", { p_run_id: id }));
}

export const setFailureType = (supabase: RunDb, id: RunId, type: FailureType | null) =>
  writeRun(
    supabase.rpc("set_failure_type", {
      p_run_id: id,
      p_version: type?.version ?? null,
      p_technique: type?.technique ?? null,
      p_step: type?.failedStep ?? null,
      p_cause: type?.causeCategory ?? null,
    }),
  );
