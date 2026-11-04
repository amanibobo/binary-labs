import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { loadNeedsLook, loadNeedsLookCount } from "@/lib/lab-data";
import { requireMember } from "@/lib/viewer";
import { NeedsLookView } from "./needs-look-view";

export const metadata: Metadata = { title: "Needs a look" };

export default async function NeedsLookPage() {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab, user } = viewer;
  const [files, count] = await Promise.all([loadNeedsLook(supabase, lab.id), loadNeedsLookCount(supabase, lab.id)]);
  return (
    <AppShell labName={lab.name} email={user.email} current="needs-look" needsLookCount={count}>
      <NeedsLookView files={files} />
    </AppShell>
  );
}
