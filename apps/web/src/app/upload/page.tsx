import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { UploadView } from "@/components/uploads/upload-view";
import { loadUploadChoices } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Upload" };

export default async function UploadPage() {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const [shell, choices] = await Promise.all([loadShell(viewer), loadUploadChoices(viewer.supabase, viewer.lab.id, viewer.user.id)]);
  return (
    <AppShell shell={shell} location={{ section: "upload" }}>
      <UploadView experiments={choices.experiments} personName={choices.personName} />
    </AppShell>
  );
}
