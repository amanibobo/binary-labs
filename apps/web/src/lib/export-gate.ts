import "server-only";
import { z } from "zod";
import { ShareBlock } from "@/components/runs/api/sharing";
import type { RunId } from "./ids";
import { fromRow } from "./run-record";
import type { RunDb } from "./run-record-store";
import { unwrap } from "./supabase/server";

// The only caller of export_gate (0037). Anything that would send a run outside the lab asks
// here first, as the signed-in member, and hands the grant to whatever builds the folder: the
// database refuses a folder without one, a second folder from the same one, and one made more
// than an hour after it. Every ask is logged, allowed or blocked.

const GateBlock = z.union([ShareBlock, z.literal("no_such_run")]);
export type GateBlock = z.infer<typeof GateBlock>;

const GateAnswer = fromRow(
  z.object({ allowed: z.boolean(), blocks: z.array(GateBlock), grantId: z.number().int().nullable(), expiresAt: z.string().nullable() }),
);

export type ExportGate = { kind: "allowed"; grantId: number; expiresAt: string } | { kind: "blocked"; blocks: GateBlock[] };

export async function askExportGate(supabase: RunDb, id: RunId, purpose: string): Promise<ExportGate> {
  const answer = GateAnswer.parse(unwrap(await supabase.rpc("export_gate", { p_run_id: id, p_purpose: purpose })));
  // Anything short of a whole grant is a no.
  if (answer.allowed && answer.grantId !== null && answer.expiresAt !== null && answer.blocks.length === 0) {
    return { kind: "allowed", grantId: answer.grantId, expiresAt: answer.expiresAt };
  }
  return { kind: "blocked", blocks: answer.blocks };
}
