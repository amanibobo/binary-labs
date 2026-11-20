import type { NextRequest } from "next/server";
import { ok } from "@/lib/protocol-routes";
import { loadPlanChoices } from "@/lib/run-evidence-store";
import { runAccess, runNotFound } from "@/lib/run-routes";

// GET ?q= is the protocol versions this run could have followed, the likeliest first.
export async function GET(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/plan/choices">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const query = (request.nextUrl.searchParams.get("q") ?? "").slice(0, 200);
  const choices = await loadPlanChoices(access.member.supabase, access.id, query);
  return choices === null ? runNotFound() : ok({ choices });
}
