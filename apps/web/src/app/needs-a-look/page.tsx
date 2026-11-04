import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { loadNeedsLook } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";
import { NeedsLookView } from "./needs-look-view";

export const metadata: Metadata = { title: "Needs a look" };

export default async function NeedsLookPage() {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const [shell, files] = await Promise.all([loadShell(viewer), loadNeedsLook(viewer.supabase, viewer.lab.id)]);
  return (
    <AppShell shell={shell} location={{ section: "needs-look" }}>
      <NeedsLookView files={files} />
    </AppShell>
  );
}
