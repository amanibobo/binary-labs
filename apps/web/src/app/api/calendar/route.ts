import { NextResponse, type NextRequest } from "next/server";
import { CalendarFilters, type RangeResponse } from "@/lib/calendar";
import { loadRange, readError, TimeZone } from "@/lib/calendar-store";
import { CalendarDay, daysBetween } from "@/lib/calendar-time";
import { ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";

const RangeParams = CalendarFilters.extend({ from: CalendarDay, to: CalendarDay, tz: TimeZone }).refine(
  (p) => daysBetween(p.from, p.to) >= 0 && daysBetween(p.from, p.to) <= 62,
  "a range is up to 62 days",
);

// GET ?from=&to=&tz= (and experiment, person, instrument): a month grid or a week, with the
// record counted per day and the plans on it.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const params = RangeParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!params.success) return NextResponse.json({ error: "invalid calendar range" }, { status: 400 });
  const { from, to, tz, ...filters } = params.data;
  try {
    return ok((await loadRange(supabase, lab.id, { first: from, last: to }, tz, filters)) satisfies RangeResponse);
  } catch (error) {
    return readError(error, { event: "calendar.range_failed", labId: lab.id });
  }
}
