import { NextResponse, type NextRequest } from "next/server";
import { DebriefChange } from "@/lib/debrief";
import { approveDebrief, debriefError, discardDebrief, saveAnswerText, setDebriefFix } from "@/lib/debrief-store";
import { DebriefId } from "@/lib/ids";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";

// POST changes an open debrief (DebriefChange) and answers with the debrief, or with the run
// once it's saved there. DELETE throws it away. The database checks the debrief is the lab's.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/debriefs/[debriefId]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const id = DebriefId.safeParse((await ctx.params).debriefId);
  if (!id.success) return NextResponse.json({ error: "Those answers don't exist any more." }, { status: 404 });
  const body = DebriefChange.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const change = body.data;
  const written = await (() => {
    switch (change.action) {
      case "text":
        return saveAnswerText(supabase, id.data, change.question, change.text, change.correction);
      case "fix":
        return setDebriefFix(supabase, id.data, change.fix);
      case "approve":
        return approveDebrief(supabase, id.data, change.useAsSuspected);
      default: {
        const _exhaustive: never = change;
        return _exhaustive;
      }
    }
  })();
  if (written.kind === "error") return debriefError(written.error, { event: `debrief.${change.action}_failed`, labId: lab.id });
  return ok(written.value);
}

export async function DELETE(_request: NextRequest, ctx: RouteContext<"/api/run-records/debriefs/[debriefId]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const id = DebriefId.safeParse((await ctx.params).debriefId);
  if (!id.success) return NextResponse.json({ error: "Those answers don't exist any more." }, { status: 404 });
  const written = await discardDebrief(supabase, id.data);
  if (written.kind === "error") return debriefError(written.error, { event: "debrief.discard_failed", labId: lab.id });
  return ok({});
}
