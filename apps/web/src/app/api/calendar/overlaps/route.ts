import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { CalendarEntryId } from "@/lib/calendar";
import { loadOverlaps, readError, TimeZone } from "@/lib/calendar-store";
import { InstrumentId } from "@/lib/ids";
import { ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";

const Instant = z.iso.datetime({ offset: true });
const OverlapParams = z.object({
  instrument: InstrumentId,
  from: Instant,
  to: Instant,
  tz: TimeZone,
  except: CalendarEntryId.optional(),
});

// GET ?instrument=&from=&to=&tz=&except=: other entries booking that instrument then.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const params = OverlapParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!params.success) return NextResponse.json({ error: "invalid overlap check" }, { status: 400 });
  const p = params.data;
  try {
    const entries = await loadOverlaps(supabase, lab.id, {
      instrumentId: p.instrument,
      from: p.from,
      to: p.to,
      timeZone: p.tz,
      except: p.except ?? null,
    });
    return ok({ entries });
  } catch (error) {
    return readError(error, { event: "calendar.overlaps_failed", labId: lab.id });
  }
}
