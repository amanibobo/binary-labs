import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { DriveView } from "@/components/drive/drive-view";
import { DriveBy } from "@/lib/drive";
import { loadDriveFolders } from "@/lib/drive-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Lab drive" };

export default async function DrivePage({ searchParams }: PageProps<"/drive">) {
  // An arrangement the address doesn't name, or names wrongly, is the first one.
  const by = DriveBy.catch("experiment").parse((await searchParams).by);
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, folders] = await Promise.all([loadShell(viewer), loadDriveFolders(supabase, lab.id, by)]);
  return (
    <AppShell shell={shell} location={{ section: "browse" }}>
      <DriveView labName={lab.name} by={by} folders={folders} />
    </AppShell>
  );
}
