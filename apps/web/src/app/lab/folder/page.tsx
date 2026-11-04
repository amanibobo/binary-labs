import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { loadNeedsLookCount, loadSourceState } from "@/lib/lab-data";
import { requireMember } from "@/lib/viewer";
import { FolderView } from "./folder-view";

export const metadata: Metadata = { title: "Choose a folder" };

export default async function FolderPage() {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab, user } = viewer;
  if (lab.role !== "admin") redirect("/lab");
  const [source, needsLook] = await Promise.all([loadSourceState(supabase, lab.id), loadNeedsLookCount(supabase, lab.id)]);
  if (source.kind === "not_connected") redirect("/lab");
  return (
    <AppShell labName={lab.name} email={user.email} current="lab" needsLookCount={needsLook}>
      <FolderView accountLabel={source.accountLabel} />
    </AppShell>
  );
}
