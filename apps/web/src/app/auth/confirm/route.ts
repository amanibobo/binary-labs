import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabase } from "@/lib/supabase/server";

// Invite emails carry a token hash rather than a PKCE code, because the admin
// API that sends them has no browser verifier.
const OtpType = z.enum(["invite", "magiclink", "email", "signup"]) satisfies z.ZodType<EmailOtpType>;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = OtpType.safeParse(params.get("type"));
  if (tokenHash !== null && type.success) {
    const supabase = await createSupabase();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type.data });
    if (error === null) return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.redirect(new URL("/sign-in?link=expired", request.url));
}
