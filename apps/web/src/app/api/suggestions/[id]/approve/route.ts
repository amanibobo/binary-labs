import { NextResponse, type NextRequest } from "next/server";
import { SuggestionId } from "@/lib/ids";
import { readJson, routeAccess } from "@/lib/route-auth";
import { approve } from "@/lib/suggestion-routes";
import { ApproveRequest } from "@/lib/suggestions";

// The one way a suggestion changes the lab: a member's click, applied as that member.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/suggestions/[id]/approve">) {
  const id = SuggestionId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "no such suggestion" }, { status: 404 });
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = ApproveRequest.safeParse(await readJson(request));
  if (!body.success) return NextResponse.json({ error: body.error.issues[0]?.message ?? "Check the page and try again." }, { status: 400 });
  return approve(supabase, { labId: lab.id, id: id.data, req: body.data });
}
