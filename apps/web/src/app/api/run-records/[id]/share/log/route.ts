import type { NextRequest } from "next/server";
import { ok } from "@/lib/protocol-routes";
import { runAccess } from "@/lib/run-routes";
import { loadSharingLog, sharingError } from "@/lib/run-sharing-store";

// GET is one run's sharing history, newest first, for any member of its lab. Another lab's
// run has no rows under the caller's lab, so it reads as empty.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/share/log">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const log = await loadSharingLog(supabase, lab.id, access.id);
  if (log.kind === "error") return sharingError(log.error, "run", { event: "run.share_log_failed", labId: lab.id });
  return ok({ log: log.value });
}
