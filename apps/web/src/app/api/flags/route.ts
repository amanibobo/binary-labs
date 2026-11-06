import { NextResponse, type NextRequest } from "next/server";
import { loadFileChecks } from "@/lib/flag-store";
import { Sha256 } from "@/lib/ids";
import { logError } from "@/lib/log";
import { ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";

// A file's checks and open flags, for its opened row; polled while a check is on its way.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const sha = Sha256.safeParse(request.nextUrl.searchParams.get("sha256"));
  if (!sha.success) return NextResponse.json({ error: "invalid sha256" }, { status: 400 });
  try {
    return ok(await loadFileChecks(supabase, lab.id, sha.data));
  } catch (error) {
    logError("flags.file_failed", { labId: lab.id, error });
    return NextResponse.json({ error: "We couldn't load this file's checks." }, { status: 500 });
  }
}
