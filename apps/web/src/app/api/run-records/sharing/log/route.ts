import { ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";
import { loadSharingLog, sharingError } from "@/lib/run-sharing-store";

// GET is the whole lab's sharing history, newest first: both switches and every export
// attempt. Admins only; the database checks it.
export async function GET() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const log = await loadSharingLog(supabase, lab.id, null);
  if (log.kind === "error") return sharingError(log.error, "lab", { event: "lab.share_log_failed", labId: lab.id });
  return ok({ log: log.value });
}
