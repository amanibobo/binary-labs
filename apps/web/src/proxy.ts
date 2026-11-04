import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { ConfigError, supabaseEnv } from "@/env";

const PUBLIC_PREFIXES = ["/sign-in", "/auth/", "/dev/"];

function readSupabaseEnv() {
  try {
    return supabaseEnv();
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}

export async function proxy(request: NextRequest) {
  const env = readSupabaseEnv();
  // Without Supabase settings the pages render a "not configured" screen.
  if (env === null) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet, headers) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  const { data } = await supabase.auth.getUser();
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p));
  // API routes answer 401 themselves rather than redirecting a fetch.
  if (data.user === null && !isPublic && !pathname.startsWith("/api/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

// /api/uploads is left out: with a proxy, Next buffers request bodies in memory and cuts
// them off at 10 MB. That route reads the session itself.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/uploads$|manifest.webmanifest$|.*\\.(?:svg|png|jpg|webp|ico)$).*)"],
};
