"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { folderPath } from "@/lib/dropbox";
import { holdTokens, revokeHeldTokens, sourceAccessToken } from "@/lib/dropbox-session";
import { UserId } from "@/lib/ids";
import { loadSourceState } from "@/lib/lab-data";
import { deletionFailure } from "@/lib/lab-deletion";
import { logError } from "@/lib/log";
import { requestOrigin } from "@/lib/origin";
import { createServiceSupabase, unwrap } from "@/lib/supabase/server";
import { loadViewer, type Member } from "@/lib/viewer";

export type ActionResult = { kind: "ok" } | { kind: "error"; message: string };

async function requireAdmin(): Promise<Member> {
  const viewer = await loadViewer();
  if (viewer.kind !== "member") redirect("/");
  if (viewer.lab.role !== "admin") throw new Error("admins only");
  return viewer;
}

const UpdatedIds = z.array(z.object({ id: z.string() })).length(1);

const FolderPath = z
  .string()
  .startsWith("/", "Pick a folder.")
  .max(1000)
  .refine((p) => p !== "/", "Pick one folder, not the whole Dropbox.");

export async function setFolder(rawPath: string): Promise<ActionResult> {
  const { supabase, lab, user } = await requireAdmin();
  const path = FolderPath.safeParse(rawPath);
  if (!path.success) return { kind: "error", message: path.error.issues[0]?.message ?? "Pick a folder." };

  const source = await loadSourceState(supabase, lab.id);
  if (source.kind === "not_connected") return { kind: "error", message: "Connect Dropbox first." };
  if (source.kind === "disconnected") return { kind: "error", message: "Connect Dropbox again first." };
  try {
    const canonical = await folderPath(await sourceAccessToken({ labId: lab.id, sourceId: source.sourceId }), path.data);
    if (canonical === null) return { kind: "error", message: "That folder isn't in Dropbox any more." };
    UpdatedIds.parse(
      unwrap(
        await supabase
          .from("sources")
          .update({ root_path: canonical, scan_requested_at: new Date().toISOString() })
          .eq("id", source.sourceId)
          .eq("lab_id", lab.id)
          .select("id"),
      ),
    );
    await audit(supabase, { labId: lab.id, actor: user.id, action: "source.set_folder", target: canonical });
    await audit(supabase, { labId: lab.id, actor: user.id, action: "scan.request", target: source.sourceId });
  } catch (error) {
    logError("source.set_folder_failed", { labId: lab.id, error });
    return { kind: "error", message: "We couldn't save that folder. Try again." };
  }
  revalidatePath("/", "layout");
  redirect("/lab");
}

export async function requestRescan(): Promise<ActionResult> {
  const { supabase, lab, user } = await requireAdmin();
  const source = await loadSourceState(supabase, lab.id);
  if (source.kind !== "connected") return { kind: "error", message: "Pick a folder before scanning." };
  try {
    UpdatedIds.parse(
      unwrap(
        await supabase
          .from("sources")
          .update({ scan_requested_at: new Date().toISOString() })
          .eq("id", source.sourceId)
          .eq("lab_id", lab.id)
          .select("id"),
      ),
    );
    await audit(supabase, { labId: lab.id, actor: user.id, action: "scan.request", target: source.sourceId });
  } catch (error) {
    logError("scan.request_failed", { labId: lab.id, error });
    return { kind: "error", message: "We couldn't request a rescan. Try again." };
  }
  revalidatePath("/", "layout");
  return { kind: "ok" };
}

// The database drops the token, stops scans and writes the audit row (0007_deletion.sql);
// the index stays searchable. The token is revoked with Dropbox once it's gone from ours.
export async function disconnectDropbox(): Promise<ActionResult> {
  const { supabase, lab } = await requireAdmin();
  const source = await loadSourceState(supabase, lab.id);
  if (source.kind === "not_connected" || source.kind === "disconnected") return { kind: "ok" };
  try {
    const held = await holdTokens({ labId: lab.id, sourceId: source.sourceId });
    unwrap(await supabase.rpc("disconnect_source", { p_source_id: source.sourceId }));
    await revokeHeldTokens(held);
  } catch (error) {
    logError("source.disconnect_failed", { labId: lab.id, error });
    return { kind: "error", message: "We couldn't disconnect Dropbox. Try again." };
  }
  revalidatePath("/", "layout");
  return { kind: "ok" };
}

export type DeleteLabState = { kind: "idle" } | { kind: "wrong_name"; typed: string } | { kind: "error"; message: string; typed: string };

// The database checks the typed name and the admin role, hides the lab from every member,
// drops the Dropbox tokens and writes lab_deletions and the audit row in one statement.
// The worker deletes the rest within minutes.
export async function deleteLab(_prev: DeleteLabState, form: FormData): Promise<DeleteLabState> {
  const { supabase, lab } = await requireAdmin();
  const typed = String(form.get("name") ?? "");
  try {
    const held = await holdTokens({ labId: lab.id });
    const { error } = await supabase.rpc("request_lab_deletion", { p_lab_id: lab.id, p_confirm_name: typed });
    if (error !== null) {
      const failure = deletionFailure(error);
      if (failure.kind === "wrong_name") return { kind: "wrong_name", typed };
      logError("lab.delete_failed", { labId: lab.id, error });
      return { kind: "error", message: failure.message, typed };
    }
    await revokeHeldTokens(held);
  } catch (error) {
    logError("lab.delete_failed", { labId: lab.id, error });
    return { kind: "error", message: "We couldn't delete the lab. Try again.", typed };
  }
  revalidatePath("/", "layout");
  redirect(`/deleted?lab=${lab.id}`);
}

export type InviteState =
  | { kind: "idle" }
  | { kind: "invited"; email: string; existingAccount: boolean }
  | { kind: "error"; message: string; email: string };

const InviteEmail = z.email("Enter an email address like name@lab.edu.").max(320);
const GeneratedUser = z.object({ user: z.object({ id: UserId }) });

type Service = ReturnType<typeof createServiceSupabase>;

async function sendInvite(service: Service, email: string): Promise<{ id: UserId; existingAccount: boolean }> {
  const invite = await service.auth.admin.inviteUserByEmail(email, { redirectTo: `${await requestOrigin()}/` });
  if (invite.error === null) return { id: UserId.parse(invite.data.user.id), existingAccount: false };
  if (invite.error.code !== "email_exists") throw invite.error;
  // Already has an account: look the user up without sending another email.
  const link = await service.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error !== null) throw link.error;
  return { id: GeneratedUser.parse(link.data).user.id, existingAccount: true };
}

export async function inviteMember(_prev: InviteState, form: FormData): Promise<InviteState> {
  const { supabase, lab, user } = await requireAdmin();
  const raw = String(form.get("email") ?? "").trim();
  const email = InviteEmail.safeParse(raw.toLowerCase());
  if (!email.success) return { kind: "error", message: email.error.issues[0]?.message ?? "Check the address.", email: raw };

  try {
    const service = createServiceSupabase();
    const invitee = await sendInvite(service, email.data);
    unwrap(
      await service
        .from("members")
        .upsert({ lab_id: lab.id, user_id: invitee.id, role: "member" }, { onConflict: "lab_id,user_id", ignoreDuplicates: true }),
    );
    await audit(supabase, { labId: lab.id, actor: user.id, action: "member.invite", target: email.data });
    revalidatePath("/lab");
    return { kind: "invited", email: email.data, existingAccount: invitee.existingAccount };
  } catch (error) {
    logError("member.invite_failed", { labId: lab.id, error });
    return { kind: "error", message: "We couldn't send that invite. Try again.", email: raw };
  }
}

// Experiments and people: any member can add one, only admins remove one (RLS enforces both).
const LAB_LISTS = {
  experiments: { table: "experiments", nameColumn: "name", noun: "experiment" },
  people: { table: "people", nameColumn: "display_name", noun: "person" },
} as const;

const LabListKind = z.enum(["experiments", "people"]);
export type LabListKind = z.infer<typeof LabListKind>;

export type ListAddState =
  | { kind: "idle" }
  | { kind: "added"; name: string }
  | { kind: "error"; message: string; name: string; aliases: string };

const EntryName = z.string().trim().min(1, "Give it a name.").max(120, "Keep the name under 120 characters.");
const EntryAliases = z
  .string()
  .transform((s) => [...new Set(s.split(",").map((a) => a.trim()).filter((a) => a !== ""))])
  .pipe(z.array(z.string().max(120, "Keep each alias under 120 characters.")).max(50, "Up to 50 aliases."));

async function requireLabMember(): Promise<Member> {
  const viewer = await loadViewer();
  if (viewer.kind !== "member") redirect("/");
  return viewer;
}

export async function addListEntry(rawKind: LabListKind, _prev: ListAddState, form: FormData): Promise<ListAddState> {
  const { supabase, lab } = await requireLabMember();
  const list = LAB_LISTS[LabListKind.parse(rawKind)];
  const rawName = String(form.get("name") ?? "");
  const rawAliases = String(form.get("aliases") ?? "");
  const fail = (message: string): ListAddState => ({ kind: "error", message, name: rawName, aliases: rawAliases });

  const name = EntryName.safeParse(rawName);
  if (!name.success) return fail(name.error.issues[0]?.message ?? "Check the name.");
  const aliases = EntryAliases.safeParse(rawAliases);
  if (!aliases.success) return fail(aliases.error.issues[0]?.message ?? "Check the aliases.");

  const { error } = await supabase
    .from(list.table)
    .insert({ lab_id: lab.id, [list.nameColumn]: name.data, aliases: aliases.data });
  if (error !== null) {
    if (error.code === "23505") return fail(`There's already ${list.noun === "person" ? "a person" : "an experiment"} called ${name.data}.`);
    logError("lab_list.add_failed", { labId: lab.id, list: list.table, error });
    return fail(`We couldn't add that ${list.noun}. Try again.`);
  }
  revalidatePath("/lab");
  return { kind: "added", name: name.data };
}

export async function removeListEntry(rawKind: LabListKind, rawId: string): Promise<ActionResult> {
  const { supabase, lab } = await requireAdmin();
  const list = LAB_LISTS[LabListKind.parse(rawKind)];
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return { kind: "error", message: `That ${list.noun} is already gone.` };
  try {
    UpdatedIds.parse(unwrap(await supabase.from(list.table).delete().eq("id", id.data).eq("lab_id", lab.id).select("id")));
  } catch (error) {
    logError("lab_list.remove_failed", { labId: lab.id, list: list.table, error });
    return { kind: "error", message: `We couldn't remove that ${list.noun}. Try again.` };
  }
  revalidatePath("/lab");
  return { kind: "ok" };
}
