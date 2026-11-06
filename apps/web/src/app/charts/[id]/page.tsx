import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ChartBuilder } from "@/components/charts/chart-builder";
import { ConfigMissing } from "@/components/config-missing";
import { loadChart, loadFileRefs, loadProvenance } from "@/lib/chart-store";
import { ChartId } from "@/lib/ids";
import { loadProtocols } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Chart" };

export default async function ChartPage({ params }: PageProps<"/charts/[id]">) {
  const id = ChartId.safeParse((await params).id);
  if (!id.success) notFound();
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, chart, protocols] = await Promise.all([loadShell(viewer), loadChart(supabase, lab.id, id.data), loadProtocols(supabase, lab.id)]);
  if (chart === null) notFound();
  const [refs, provenance] = await Promise.all([loadFileRefs(supabase, lab.id, [chart.sha256]), loadProvenance(supabase, lab.id, chart)]);
  const ref = refs.get(chart.sha256);
  return (
    <AppShell shell={shell} location={{ section: "search" }}>
      <ChartBuilder
        file={ref ?? { locationId: null, sha256: chart.sha256, name: "A file no longer in the lab" }}
        mode={{ kind: "edit", chart, provenance }}
        protocols={protocols.map((p) => ({ id: p.id, title: p.title }))}
      />
    </AppShell>
  );
}
