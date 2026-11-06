import "server-only";
import { z } from "zod";
import { ExpectedValuesRows, type CheckSpec } from "./checks";
import {
  FileCheckRows,
  FlagMarkRows,
  FlagQueueCount,
  FlagRows,
  UsefulnessRows,
  type FileChecks,
  type Flag,
  type UsefulnessByCheck,
} from "./flags";
import { Sha256, type FlagId, type LabId, type ProtocolId, type ProtocolVersionId } from "./ids";
import { unwrap, type Supabase } from "./supabase/server";

// Reads for flags and checks, all through the member's session so RLS decides what a lab sees.

// The Flags list and a protocol's flags are the lab's open ones; a flag's own page shows it
// whatever became of it.
export async function loadOpenFlags(supabase: Supabase, labId: LabId, where?: { protocolId: ProtocolId }): Promise<Flag[]> {
  const query = supabase.rpc("lab_flags", { p_lab_id: labId }).is("cleared_at", null);
  const filtered = where === undefined ? query : query.eq("protocol_id", where.protocolId);
  return FlagRows.parse(unwrap(await filtered.order("raised_at", { ascending: false }).limit(500)));
}

export async function loadFlag(supabase: Supabase, labId: LabId, id: FlagId): Promise<Flag | null> {
  const [flag] = FlagRows.parse(unwrap(await supabase.rpc("lab_flags", { p_lab_id: labId }).eq("id", id).limit(1)));
  return flag ?? null;
}

export async function loadFlagQueueCount(supabase: Supabase, labId: LabId): Promise<number> {
  return FlagQueueCount.parse(unwrap(await supabase.rpc("flag_queue_count", { p_lab_id: labId })));
}

export async function loadFileChecks(supabase: Supabase, labId: LabId, sha: Sha256): Promise<FileChecks> {
  const [checks, flags, waiting] = await Promise.all([
    supabase.rpc("file_checks", { p_lab_id: labId, p_sha256: sha }),
    supabase.rpc("lab_flags", { p_lab_id: labId }).eq("sha256", sha).is("cleared_at", null).order("raised_at", { ascending: false }),
    supabase.from("check_requests").select("requested_at, checked_at").eq("lab_id", labId).eq("sha256", sha).limit(1),
  ]);
  const [request] = z.array(z.object({ requested_at: z.string(), checked_at: z.string().nullable() })).parse(unwrap(waiting));
  return {
    checking: request !== undefined && (request.checked_at === null || Date.parse(request.requested_at) > Date.parse(request.checked_at)),
    checks: FileCheckRows.parse(unwrap(checks)),
    flags: FlagRows.parse(unwrap(flags)),
  };
}

export async function loadFlagMarks(supabase: Supabase, labId: LabId, shas: readonly Sha256[]): Promise<Record<string, number>> {
  if (shas.length === 0) return {};
  const rows = FlagMarkRows.parse(unwrap(await supabase.rpc("file_flag_marks", { p_lab_id: labId, p_shas: [...shas] })));
  return Object.fromEntries(rows.map((r) => [r.sha256, r.flags]));
}

export async function loadVersionChecks(supabase: Supabase, versionId: ProtocolVersionId): Promise<CheckSpec[]> {
  return ExpectedValuesRows.parse(unwrap(await supabase.from("protocol_versions").select("expected_values").eq("id", versionId).limit(1)));
}

// Only admins see how a lab answered its flags; for anyone else it's left out.
export async function loadUsefulness(supabase: Supabase, labId: LabId, isAdmin: boolean): Promise<UsefulnessByCheck | null> {
  if (!isAdmin) return null;
  return UsefulnessRows.parse(unwrap(await supabase.rpc("check_usefulness", { p_lab_id: labId })));
}

export const FlagMarksQuery = z.object({
  shas: z
    .string()
    .transform((s) => s.split(","))
    .pipe(z.array(Sha256).min(1).max(200)),
});
