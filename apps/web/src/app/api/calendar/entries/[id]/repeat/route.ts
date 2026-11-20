import { NextResponse, type NextRequest } from "next/server";
import { CalendarEntryId, RepeatRequest } from "@/lib/calendar";
import { entryError, setRepeat, TimeZone } from "@/lib/calendar-store";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";

// POST { rule, basedOn, timeZone }: how the entry repeats from here on (null stops it). Answers
// as a save does, 409 when someone saved it first.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/calendar/entries/[id]/repeat">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const id = CalendarEntryId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid entry id" }, { status: 400 });
  const body = RepeatRequest.extend({ timeZone: TimeZone }).safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const saved = await setRepeat(supabase, id.data, body.data);
  if (saved.kind === "error") return entryError(saved.error, { event: "calendar.repeat_failed", labId: lab.id });
  if (saved.outcome.kind === "stale") return NextResponse.json(saved.outcome, { status: 409, headers: { "cache-control": "private, no-store" } });
  return ok(saved.outcome);
}
