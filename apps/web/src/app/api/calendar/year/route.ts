import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { CalendarFilters } from "@/lib/calendar";
import { MAX_YEAR, MIN_YEAR } from "@/lib/calendar-nav";
import { loadYear, readError, TimeZone } from "@/lib/calendar-store";
import type { YearResponse } from "@/lib/calendar-year";
import { ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";

const YearParams = CalendarFilters.extend({ year: z.coerce.number().int().min(MIN_YEAR).max(MAX_YEAR), tz: TimeZone });

// GET ?year=&tz= (and filters): per day of the year, how many plans and how much on the record.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const params = YearParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!params.success) return NextResponse.json({ error: "invalid calendar year" }, { status: 400 });
  const { year, tz, ...filters } = params.data;
  try {
    return ok((await loadYear(supabase, lab.id, year, tz, filters)) satisfies YearResponse);
  } catch (error) {
    return readError(error, { event: "calendar.year_failed", labId: lab.id });
  }
}
