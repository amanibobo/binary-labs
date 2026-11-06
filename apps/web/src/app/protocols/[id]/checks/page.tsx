import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { CheckEditor } from "@/components/flags/check-editor";
import { loadUsefulness, loadVersionChecks } from "@/lib/flag-store";
import { CheckId, ProtocolId } from "@/lib/ids";
import { loadProtocolVersion } from "@/lib/lab-data";
import { protocolHref } from "@/lib/protocols";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Checks" };

export default async function ChecksPage({ params, searchParams }: PageProps<"/protocols/[id]/checks">) {
  const id = ProtocolId.safeParse((await params).id);
  if (!id.success) notFound();
  const focus = CheckId.safeParse((await searchParams).check);
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, page, usefulness] = await Promise.all([
    loadShell(viewer),
    loadProtocolVersion(supabase, id.data, null),
    loadUsefulness(supabase, lab.id, lab.role === "admin"),
  ]);
  if (page === null) notFound();
  // Tutorials don't carry checks, and an archived protocol can't change.
  if (page.kind !== "protocol" || page.archived) redirect(protocolHref(page.protocolId));
  const checks = await loadVersionChecks(supabase, page.id);
  return (
    <AppShell shell={shell} location={{ section: "protocols" }}>
      <CheckEditor key={page.id} page={page} checks={checks} usefulness={usefulness} focus={focus.success ? focus.data : null} />
    </AppShell>
  );
}
