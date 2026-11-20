import { ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";
import { loadFailureList } from "@/lib/run-failure-store";

// GET is the newest version of the fixed failure list, in picker order.
export async function GET() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  return ok(await loadFailureList(access.member.supabase));
}
