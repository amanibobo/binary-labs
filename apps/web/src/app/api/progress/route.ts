import { NextResponse } from "next/server";
import { loadSourceState } from "@/lib/lab-data";
import { routeAccess } from "@/lib/route-auth";

export async function GET() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  return NextResponse.json(await loadSourceState(supabase, lab.id), { headers: { "cache-control": "private, no-store" } });
}
