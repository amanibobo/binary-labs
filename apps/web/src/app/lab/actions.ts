"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { folderPath } from "@/lib/dropbox";
import { sourceAccessToken } from "@/lib/dropbox-session";
import { UserId } from "@/lib/ids";
import { loadSourceState } from "@/lib/lab-data";
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
