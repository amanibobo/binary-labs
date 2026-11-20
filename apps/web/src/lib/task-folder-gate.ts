import "server-only";
import type { RunId } from "./ids";
import type { Supabase } from "./supabase/server";

// The one way the task folder asks whether a run may leave the lab. The gate itself is the
// sharing slice's (migration 0037, lib/export-gate.ts), which wasn't merged when this was
// written, so until then this answers no for every run and nothing can be built or
// downloaded. Once it is merged, this file becomes one line and nothing else changes:
//
//   export { claimExport, type ExportGrant, type GateAnswer } from "./export-gate";
//
// The shapes below are the foundation's design for that module.

export type ExportGrant = { runId: RunId; logId: number };
export type GateAnswer = { kind: "granted"; grant: ExportGrant } | { kind: "blocked"; reasons: readonly string[] };

export async function claimExport(_supabase: Supabase, _runId: RunId, _purpose: string): Promise<GateAnswer> {
  return { kind: "blocked", reasons: ["gate_not_built"] };
}
