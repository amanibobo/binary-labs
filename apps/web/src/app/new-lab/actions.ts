"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { CreateLabResult } from "@/lib/domain";
import { logError } from "@/lib/log";
import { unwrap } from "@/lib/supabase/server";
import { loadViewer } from "@/lib/viewer";

export type CreateLabState = { kind: "idle" } | { kind: "error"; message: string; name: string };

const LabName = z.string().trim().min(1, "Give the lab a name.").max(120, "Keep the name under 120 characters.");

export async function createLab(_prev: CreateLabState, form: FormData): Promise<CreateLabState> {
  const raw = String(form.get("name") ?? "");
  const name = LabName.safeParse(raw);
  if (!name.success) return { kind: "error", message: name.error.issues[0]?.message ?? "Check the name.", name: raw };

  const viewer = await loadViewer();
  if (viewer.kind === "signed_out" || viewer.kind === "config_missing") redirect("/sign-in");
  if (viewer.kind === "member") redirect("/");
  try {
    CreateLabResult.parse(unwrap(await viewer.supabase.rpc("create_lab", { p_name: name.data })));
  } catch (error) {
    logError("lab.create_failed", { error });
    return { kind: "error", message: "We couldn't create the lab. Try again.", name: raw };
  }
  redirect("/lab");
}
