"use server";

import { redirect } from "next/navigation";
import { createSupabase } from "@/lib/supabase/server";

export async function signOut(): Promise<void> {
  const supabase = await createSupabase();
  await supabase.auth.signOut();
  redirect("/sign-in");
}
