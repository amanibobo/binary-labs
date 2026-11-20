import { ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";
import { dismissRunSuggestions, loadRunSuggestions } from "@/lib/run-record-store";

// GET is "Turn these into runs?": files a person vouched for that say how they went and
// aren't in a run. DELETE puts the list away for the caller, for good.
export async function GET() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  return ok({ suggestions: await loadRunSuggestions(supabase, lab.id) });
}

export async function DELETE() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  await dismissRunSuggestions(supabase, lab.id);
  return ok({});
}
