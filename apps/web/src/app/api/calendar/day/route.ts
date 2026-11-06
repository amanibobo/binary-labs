import { NextResponse, type NextRequest } from "next/server";
import { CalendarFilters, type DayResponse } from "@/lib/calendar";
import { loadDay, readError, TimeZone } from "@/lib/calendar-store";
import { CalendarDay } from "@/lib/calendar-time";
import { ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";

const DayParams = CalendarFilters.extend({ day: CalendarDay, tz: TimeZone });

// GET ?day=&tz= (and filters): one day's record, with the first files of each group.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const params = DayParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!params.success) return NextResponse.json({ error: "invalid day" }, { status: 400 });
  const { day, tz, ...filters } = params.data;
  try {
    return ok((await loadDay(supabase, lab.id, { day, timeZone: tz, filters })) satisfies DayResponse);
  } catch (error) {
    return readError(error, { event: "calendar.day_failed", labId: lab.id });
  }
}
