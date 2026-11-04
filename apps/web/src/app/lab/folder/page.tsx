import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { loadSourceState } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";
import { FolderView } from "./folder-view";

export const metadata: Metadata = { title: "Choose a folder" };

export default async function FolderPage() {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  if (lab.role !== "admin") redirect("/lab");
  const [shell, source] = await Promise.all([loadShell(viewer), loadSourceState(supabase, lab.id)]);
  if (source.kind === "not_connected" || source.kind === "disconnected") redirect("/lab");
  return (
    <AppShell shell={shell} location={{ section: "lab" }}>
      <FolderView accountLabel={source.accountLabel} />
    </AppShell>
  );
}
