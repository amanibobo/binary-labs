import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { CalendarFilters, MORE_FILES_PAGE, RecordKind } from "@/lib/calendar";
import { loadDayFiles, readError, TimeZone } from "@/lib/calendar-store";
import { CalendarDay } from "@/lib/calendar-time";
import { ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";

const FilesParams = CalendarFilters.extend({
  day: CalendarDay,
  tz: TimeZone,
  kind: RecordKind,
  group: z.uuid().optional(),
  offset: z.string().regex(/^\d{1,6}$/).transform(Number).default(0),
});

// GET ?day=&tz=&kind=&group=&offset=: more of one group's files on a day.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const params = FilesParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!params.success) return NextResponse.json({ error: "invalid day files" }, { status: 400 });
  const { day, tz, kind, group, offset, ...filters } = params.data;
  try {
    const files = await loadDayFiles(
      supabase,
      lab.id,
      { day, timeZone: tz, filters, kind, groupId: group ?? null },
      { offset, limit: MORE_FILES_PAGE },
    );
    return ok({ files });
  } catch (error) {
    return readError(error, { event: "calendar.files_failed", labId: lab.id });
  }
}
