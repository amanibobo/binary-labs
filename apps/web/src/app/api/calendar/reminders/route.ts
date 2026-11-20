import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { CalendarEntryId, type DueReminder } from "@/lib/calendar";
import { loadDueReminders, markReminderShown, readError, TimeZone } from "@/lib/calendar-store";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";

// GET ?tz=: the caller's reminders that are due now, soonest first.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const tz = TimeZone.safeParse(request.nextUrl.searchParams.get("tz"));
  if (!tz.success) return NextResponse.json({ error: "invalid time zone" }, { status: 400 });
  try {
    const due = await loadDueReminders(supabase, lab.id, tz.data);
    return ok({ due: due.map((d): DueReminder => ({ entry: d.entry, minutes: d.minutes, at: d.at })) });
  } catch (error) {
    return readError(error, { event: "calendar.reminders_failed", labId: lab.id });
  }
}

const Shown = z.object({ entryId: CalendarEntryId, minutes: z.number().int().min(0), at: z.iso.datetime({ offset: true }) });

// POST { entryId, minutes, at }: the reminder was shown for that moment, so it isn't again.
export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = Shown.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  try {
    await markReminderShown(supabase, body.data);
    return ok({});
  } catch (error) {
    return readError(error, { event: "calendar.reminder_shown_failed", labId: lab.id });
  }
}
