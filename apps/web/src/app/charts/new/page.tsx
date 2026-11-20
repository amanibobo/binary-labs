import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ChartBuilder } from "@/components/charts/chart-builder";
import { ConfigMissing } from "@/components/config-missing";
import { loadChartFile } from "@/lib/chart-store";
import { CitedCell } from "@/lib/charts";
import { LocationId, ProtocolId } from "@/lib/ids";
import { loadProtocols } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "New chart" };

export default async function NewChartPage({ searchParams }: PageProps<"/charts/new">) {
  const params = await searchParams;
  const location = LocationId.safeParse(params.file);
  if (!location.success) notFound();
  const protocol = ProtocolId.safeParse(params.protocol);
  const cited = CitedCell.safeParse({ sheet: params.sheet, column: params.column, row: params.row });
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, found, protocols] = await Promise.all([
    loadShell(viewer),
    loadChartFile(supabase, lab.id, location.data),
    loadProtocols(supabase, lab.id),
  ]);
  if (found.kind === "missing") notFound();
  return (
    <AppShell shell={shell} location={{ section: "search" }}>
      {found.kind === "not_a_sheet" ? (
        <div className="mx-auto w-full max-w-3xl px-4 pt-12 sm:px-8">
          <p className="text-paragraph-medium text-content-secondary">
            {found.name} isn&apos;t a spreadsheet or CSV, so there&apos;s no table to chart.
          </p>
        </div>
      ) : (
        <ChartBuilder
          file={found.file}
          mode={{ kind: "create", protocolId: protocol.success ? protocol.data : null, cited: cited.success ? cited.data : null }}
          protocols={protocols.map((p) => ({ id: p.id, title: p.title }))}
        />
      )}
    </AppShell>
  );
}
