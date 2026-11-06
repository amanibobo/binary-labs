import { NextResponse, type NextRequest } from "next/server";
import { SuggestionId } from "@/lib/ids";
import { routeAccess } from "@/lib/route-auth";
import { suggestionError } from "@/lib/suggestion-routes";

export async function POST(_request: NextRequest, ctx: RouteContext<"/api/suggestions/[id]/dismiss">) {
  const id = SuggestionId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "no such suggestion" }, { status: 404 });
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const { error } = await supabase.rpc("dismiss_suggestion", { p_id: id.data });
  if (error !== null) return suggestionError(error, { event: "suggestions.dismiss_failed", labId: lab.id });
  return NextResponse.json({ kind: "dismissed" }, { headers: { "cache-control": "private, no-store" } });
}
