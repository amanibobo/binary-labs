import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { z } from "zod";
import { ConfigError } from "@/env";
import { MemberRole } from "./domain";
import { LabId, UserId } from "./ids";
import { createSupabase, unwrap, type Supabase } from "./supabase/server";

export type Lab = { id: LabId; name: string; role: MemberRole };
export type User = { id: UserId; email: string };

export type Viewer =
  | { kind: "config_missing"; missing: readonly string[] }
  | { kind: "signed_out" }
  | { kind: "no_lab"; user: User; supabase: Supabase }
  | { kind: "member"; user: User; lab: Lab; supabase: Supabase };

const Membership = z.object({
  role: MemberRole,
  labs: z.object({ id: LabId, name: z.string() }),
});

// One current lab per user for now: the first membership.
export const loadViewer = cache(async (): Promise<Viewer> => {
  let supabase: Supabase;
  try {
    supabase = await createSupabase();
  } catch (err) {
    if (err instanceof ConfigError) return { kind: "config_missing", missing: err.missing };
    throw err;
  }
  const { data } = await supabase.auth.getUser();
  if (data.user === null) return { kind: "signed_out" };
  const user: User = { id: UserId.parse(data.user.id), email: data.user.email ?? "" };

  const rows = z.array(Membership).parse(
    unwrap(
      await supabase
        .from("members")
        .select("role, labs!inner(id, name)")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true })
        .limit(1),
    ),
  );
  const first = rows[0];
  if (first === undefined) return { kind: "no_lab", user, supabase };
  return { kind: "member", user, supabase, lab: { id: first.labs.id, name: first.labs.name, role: first.role } };
});

export type Member = Extract<Viewer, { kind: "member" }>;

export async function requireMember(): Promise<Member | Extract<Viewer, { kind: "config_missing" }>> {
  const viewer = await loadViewer();
  switch (viewer.kind) {
    case "config_missing":
    case "member":
      return viewer;
    case "signed_out":
      return redirect("/sign-in");
    case "no_lab":
      return redirect("/new-lab");
    default: {
      const _exhaustive: never = viewer;
      return _exhaustive;
    }
  }
}
