import "server-only";
import type { RunId } from "./ids";
import { RunModelChecksJson, type ModelCheckRequest, type RunModelChecks } from "./model-check";
import type { RunDb, Written } from "./run-record-store";
import { unwrap } from "./supabase/server";

// The model check's reads and writes, as the member under RLS. Each write is one database
// function that checks the lab itself; every answer is the run's whole model check again.

export async function loadModelChecks(supabase: RunDb, runId: RunId): Promise<RunModelChecks | null> {
  const json = unwrap(await supabase.rpc("run_model_checks_json", { p_run_id: runId }));
  return json === null ? null : RunModelChecksJson.parse(json);
}

function call(supabase: RunDb, request: ModelCheckRequest) {
  switch (request.action) {
    case "start":
      return supabase.rpc("request_model_check", { p_task_id: request.taskId });
    case "judge":
      return supabase.rpc("judge_model_answer", { p_answer_id: request.answerId, p_solved: request.solved, p_note: request.note });
    case "keep":
      return supabase.rpc("keep_model_task", { p_task_id: request.taskId, p_keep: request.keep });
    default: {
      const _exhaustive: never = request;
      return _exhaustive;
    }
  }
}

export async function writeModelCheck(supabase: RunDb, runId: RunId, request: ModelCheckRequest): Promise<Written<RunModelChecks | null>> {
  const { error } = await call(supabase, request);
  if (error !== null) return { kind: "error", error };
  return { kind: "ok", value: await loadModelChecks(supabase, runId) };
}
