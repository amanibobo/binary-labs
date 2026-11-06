import { NextResponse, type NextRequest } from "next/server";
import { FlagMarksQuery, loadFlagMarks } from "@/lib/flag-store";
import { logError } from "@/lib/log";
import { ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";

// Open flags per file for the rows on screen, which turn a row amber.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const query = FlagMarksQuery.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: "invalid flag parameters" }, { status: 400 });
  try {
    return ok(await loadFlagMarks(supabase, lab.id, query.data.shas));
  } catch (error) {
    logError("flags.marks_failed", { labId: lab.id, error });
    return NextResponse.json({ error: "flags failed" }, { status: 500 });
  }
}
