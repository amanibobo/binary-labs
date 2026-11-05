import { NextResponse, type NextRequest } from "next/server";
import { logError } from "@/lib/log";
import { noteArgs, OnboardingEvent } from "@/lib/onboarding";
import { readJson, routeAccess } from "@/lib/route-auth";

// Records one thing a person did with onboarding (saw the welcome, reached a tour step, saw a
// hint). note_onboarding only ever writes the caller's own row.
export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const event = OnboardingEvent.safeParse(await readJson(request));
  if (!event.success) return NextResponse.json({ error: "bad onboarding event" }, { status: 400 });

  const { error } = await supabase.rpc("note_onboarding", noteArgs(event.data));
  if (error !== null) {
    logError("onboarding.note_failed", { labId: lab.id, kind: event.data.kind, error });
    return NextResponse.json({ error: "not saved" }, { status: 500 });
  }
  return new NextResponse(null, { status: 204 });
}
