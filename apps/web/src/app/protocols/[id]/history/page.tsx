import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { HistoryView } from "@/components/protocols/history-view";
import { ProtocolId } from "@/lib/ids";
import { loadAuthorNames, loadProtocolHistory, loadProtocolVersion } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "History" };

export default async function ProtocolHistoryPage({ params }: PageProps<"/protocols/[id]/history">) {
  const id = ProtocolId.safeParse((await params).id);
  if (!id.success) notFound();
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, page, versions, authors] = await Promise.all([
    loadShell(viewer),
    loadProtocolVersion(supabase, id.data, null),
    loadProtocolHistory(supabase, id.data),
    loadAuthorNames(supabase, lab.id),
  ]);
  if (page === null) notFound();
  return (
    <AppShell shell={shell} location={{ section: "protocols" }}>
      <HistoryView page={page} versions={versions} authors={authors} />
    </AppShell>
  );
}
