import { NextResponse, type NextRequest } from "next/server";
import { createSupabase } from "@/lib/supabase/server";

// Magic links started from /sign-in come back here with a PKCE code.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (code !== null) {
    const supabase = await createSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error === null) return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.redirect(new URL("/sign-in?link=expired", request.url));
}
