import "server-only";
import { NextResponse } from "next/server";
import { debriefFailure, DebriefJson, MaybeDebriefJson, type Debrief, type DebriefQuestion } from "./debrief";
import type { DebriefId, LabId, RunId } from "./ids";
import { logError } from "./log";
import type { RunFix, RunRecord } from "./run-record";
import { RunJson } from "./run-record";
import type { RunDb, Written } from "./run-record-store";
import { unwrap } from "./supabase/server";

// The debrief's reads and writes, as the member under RLS. Each is one database function that
// checks the lab itself; this file names the arguments and parses what comes back.

async function written<T>(call: PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>, parse: (data: unknown) => T): Promise<Written<T>> {
  const { data, error } = await call;
  return error !== null ? { kind: "error", error } : { kind: "ok", value: parse(data) };
}

const debriefOf = (data: unknown) => DebriefJson.parse(data);

export async function loadRunDebrief(supabase: RunDb, runId: RunId): Promise<Debrief | null> {
  return MaybeDebriefJson.parse(unwrap(await supabase.rpc("run_debrief", { p_run_id: runId })));
}

export const startDebrief = (supabase: RunDb, runId: RunId) => written(supabase.rpc("start_debrief", { p_run_id: runId }), debriefOf);

export const saveAnswerText = (supabase: RunDb, id: DebriefId, question: DebriefQuestion, text: string, correction: boolean) =>
  written(supabase.rpc("save_answer_text", { p_debrief_id: id, p_question: question, p_text: text, p_correction: correction }), debriefOf);

export const setDebriefFix = (supabase: RunDb, id: DebriefId, fix: RunFix | null) =>
  written(supabase.rpc("set_debrief_fix", { p_debrief_id: id, p_fix: fix }), debriefOf);

export const approveDebrief = (supabase: RunDb, id: DebriefId, useAsSuspected: boolean): Promise<Written<RunRecord>> =>
  written(supabase.rpc("approve_debrief", { p_debrief_id: id, p_use_as_suspected: useAsSuspected }), (data) => RunJson.parse(data));

export const discardDebrief = (supabase: RunDb, id: DebriefId) => written(supabase.rpc("discard_debrief", { p_debrief_id: id }), () => null);

// A database error from a debrief function, as the browser should see it.
export function debriefError(error: { code?: string; message: string }, ctx: { event: string; labId: LabId }): NextResponse {
  const failure = debriefFailure(error);
  if (failure.status === 500) logError(ctx.event, { labId: ctx.labId, error });
  return NextResponse.json({ error: failure.message }, { status: failure.status, headers: { "cache-control": "private, no-store" } });
}
