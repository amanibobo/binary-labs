import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { ProtocolEditor } from "@/components/protocols/protocol-editor";
import { ProtocolId } from "@/lib/ids";
import { loadAuthorNames, loadProtocolVersion } from "@/lib/lab-data";
import { protocolHref } from "@/lib/protocols";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Edit page" };

export default async function EditProtocolPage({ params }: PageProps<"/protocols/[id]/edit">) {
  const id = ProtocolId.safeParse((await params).id);
  if (!id.success) notFound();
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, page, authors] = await Promise.all([
    loadShell(viewer),
    loadProtocolVersion(supabase, id.data, null),
    loadAuthorNames(supabase, lab.id),
  ]);
  if (page === null) notFound();
  if (page.archived) redirect(protocolHref(page.protocolId));
  return (
    <AppShell shell={shell} location={{ section: "protocols" }}>
      <ProtocolEditor key={page.id} mode={{ kind: "edit", page }} authors={authors} />
    </AppShell>
  );
}
