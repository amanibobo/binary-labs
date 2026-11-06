import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { FlagsView } from "@/components/flags/flags-view";
import { loadOpenFlags } from "@/lib/flag-store";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Flags" };

export default async function FlagsPage() {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const [shell, flags] = await Promise.all([loadShell(viewer), loadOpenFlags(viewer.supabase, viewer.lab.id)]);
  return (
    <AppShell shell={shell} location={{ section: "flags" }}>
      <FlagsView flags={flags} />
    </AppShell>
  );
}
