import { NextResponse, type NextRequest } from "next/server";
import { CalendarEntryId, RemindersRequest } from "@/lib/calendar";
import { entryError, setReminders } from "@/lib/calendar-store";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";

// POST { minutes, scope }: the caller's own reminders on the entry, or on all of its series.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/calendar/entries/[id]/reminders">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const id = CalendarEntryId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid entry id" }, { status: 400 });
  const body = RemindersRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const saved = await setReminders(supabase, id.data, body.data);
  if (saved.kind === "error") return entryError(saved.error, { event: "calendar.reminders_failed", labId: lab.id });
  if (saved.entry === null) return NextResponse.json({ error: "Someone deleted this entry." }, { status: 404 });
  return ok(saved.entry);
}
