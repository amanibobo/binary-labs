import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { serviceRoleEnv, supabaseEnv } from "@/env";

// The user's session client: every read and write through it is subject to RLS.
export async function createSupabase() {
  // Read cookies before env so pages stay dynamic even when a build has no env.
  const store = await cookies();
  const env = supabaseEnv();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch {
          // Server Components can't set cookies; the proxy refreshes the session instead.
        }
      },
    },
  });
}

export type Supabase = Awaited<ReturnType<typeof createSupabase>>;

// Bypasses RLS. Only for member invites and reading a source's encrypted token.
export function createServiceSupabase() {
  const { NEXT_PUBLIC_SUPABASE_URL } = supabaseEnv();
  const { SUPABASE_SERVICE_ROLE_KEY } = serviceRoleEnv();
  return createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// supabase-js types untyped rows as `any`; this hands them on as `unknown` so
// a zod parse is the only way forward.
export function unwrap(result: { data: unknown; error: { message: string; code?: string } | null }): unknown {
  if (result.error !== null) throw new Error(`supabase: ${result.error.message} (${result.error.code ?? "no code"})`);
  return result.data;
}
