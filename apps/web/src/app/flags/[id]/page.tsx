import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { FlagView } from "@/components/flags/flag-view";
import { loadFlag } from "@/lib/flag-store";
import { FlagId } from "@/lib/ids";
import { loadAuthorNames } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Flag" };

export default async function FlagPage({ params }: PageProps<"/flags/[id]">) {
  const id = FlagId.safeParse((await params).id);
  if (!id.success) notFound();
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, flag, authors] = await Promise.all([loadShell(viewer), loadFlag(supabase, lab.id, id.data), loadAuthorNames(supabase, lab.id)]);
  if (flag === null) notFound();
  return (
    <AppShell shell={shell} location={{ section: "flags" }}>
      <FlagView flag={flag} authors={authors} />
    </AppShell>
  );
}
