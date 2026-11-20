import type { NextRequest } from "next/server";
import { SetRunShareRequest } from "@/components/runs/api/sharing";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson } from "@/lib/route-auth";
import { runAccess, runNotFound } from "@/lib/run-routes";
import { loadRunSharing, setRunShare, sharingError } from "@/lib/run-sharing-store";

// GET is the run's side of sharing: its switch, whether it's the caller's to change, and what
// still stops it leaving. POST turns the switch on or off, for the person who ran it or an
// admin.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/share">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const sharing = await loadRunSharing(access.member.supabase, access.id);
  return sharing === null ? runNotFound() : ok(sharing);
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/share">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = SetRunShareRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await setRunShare(supabase, access.id, body.data.on);
  if (written.kind === "error") return sharingError(written.error, "run", { event: "run.share_failed", labId: lab.id });
  return ok(written.value);
}
