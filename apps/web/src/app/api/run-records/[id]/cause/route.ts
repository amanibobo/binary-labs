import type { NextRequest } from "next/server";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson } from "@/lib/route-auth";
import type { RunId } from "@/lib/ids";
import { CauseRequest } from "@/lib/run-failure";
import { attestCause, confirmCause, failureError, loadConfirmerChoices, setSuspectedCause, withdrawCause } from "@/lib/run-failure-store";
import type { RunDb } from "@/lib/run-record-store";
import { runAccess } from "@/lib/run-routes";

// GET is who can be named as the confirmer: the lab's People, with the caller's own row marked.
// POST writes the suspected cause, confirms the cause, takes the confirmation back, or is the
// named confirmer's own "Yes, I confirmed this".
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/cause">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  return ok({ people: await loadConfirmerChoices(access.member.supabase, access.id) });
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/cause">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = CauseRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await write(supabase, access.id, body.data);
  if (written.kind === "error") return failureError(written.error, { event: "run.cause_failed", labId: lab.id });
  return ok(written.value);
}

function write(supabase: RunDb, id: RunId, req: CauseRequest) {
  switch (req.action) {
    case "suspect":
      return setSuspectedCause(supabase, id, req.cause);
    case "confirm":
      return confirmCause(supabase, id, req.confirm);
    case "withdraw":
      return withdrawCause(supabase, id);
    case "attest":
      return attestCause(supabase, id);
    default: {
      const _exhaustive: never = req;
      return _exhaustive;
    }
  }
}
