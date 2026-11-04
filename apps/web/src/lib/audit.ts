import "server-only";
import type { AuditAction } from "./domain";
import type { LabId, UserId } from "./ids";
import { logError } from "./log";
import { unwrap, type Supabase } from "./supabase/server";

type AuditEntry = { labId: LabId; actor: UserId; action: AuditAction; target: string | null };

export async function audit(supabase: Supabase, entry: AuditEntry): Promise<void> {
  unwrap(
    await supabase
      .from("audit_log")
      .insert({ lab_id: entry.labId, actor: entry.actor, action: entry.action, target: entry.target }),
  );
}

// For reads (search, preview views) where a failed audit write shouldn't fail the read.
export async function auditQuietly(supabase: Supabase, entry: AuditEntry): Promise<void> {
  try {
    await audit(supabase, entry);
  } catch (error) {
    logError("audit.write_failed", { action: entry.action, labId: entry.labId, error });
  }
}
