import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { RunHistoryView } from "@/components/charts/history-chart";
import { ConfigMissing } from "@/components/config-missing";
import { CheckId, ProtocolId } from "@/lib/ids";
import { loadRunHistory } from "@/lib/run-store";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Run history" };

// A protocol check's value across the runs it was checked on (decisions.md, "charts round 2").
// ?check= picks the check; without it, the protocol's first.
export default async function RunHistoryPage({ params, searchParams }: PageProps<"/protocols/[id]/runs">) {
  const id = ProtocolId.safeParse((await params).id);
  if (!id.success) notFound();
  const check = CheckId.safeParse((await searchParams).check);
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, history] = await Promise.all([loadShell(viewer), loadRunHistory(supabase, lab.id, id.data, check.success ? check.data : null)]);
  if (history === null) notFound();
  return (
    <AppShell shell={shell} location={{ section: "protocols" }}>
      <RunHistoryView history={history} />
    </AppShell>
  );
}
