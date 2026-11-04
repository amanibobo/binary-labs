"use server";

import { z } from "zod";
import { ConfigError } from "@/env";
import { logError } from "@/lib/log";
import { requestOrigin } from "@/lib/origin";
import { createSupabase } from "@/lib/supabase/server";

export type SignInState =
  | { kind: "idle" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string; email: string };

const Email = z.email().max(320);

export async function sendMagicLink(_prev: SignInState, form: FormData): Promise<SignInState> {
  const raw = String(form.get("email") ?? "").trim();
  const email = Email.safeParse(raw);
  if (!email.success) return { kind: "error", message: "Enter an email address like name@lab.edu.", email: raw };
  try {
    const supabase = await createSupabase();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.data,
      options: { emailRedirectTo: `${await requestOrigin()}/auth/callback` },
    });
    if (error !== null) {
      logError("auth.magic_link_failed", { error: error.message });
      return { kind: "error", message: "We couldn't send the link. Try again in a minute.", email: raw };
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      return { kind: "error", message: `Sign-in isn't configured: set ${error.missing.join(", ")}.`, email: raw };
    }
    throw error;
  }
  return { kind: "sent", email: email.data };
}
