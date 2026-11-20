import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { RunsListView } from "@/components/runs/runs-list";
import { RunListFilter } from "@/lib/run-record";
import { loadLabRuns, loadRunSuggestions } from "@/lib/run-record-store";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Runs" };

export default async function RunsPage({ searchParams }: PageProps<"/runs">) {
  // A filter that doesn't parse is no filter.
  const filter = RunListFilter.catch({}).parse(await searchParams);
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, runs, suggestions] = await Promise.all([loadShell(viewer), loadLabRuns(supabase, lab.id, filter, 0), loadRunSuggestions(supabase, lab.id)]);
  return (
    <AppShell shell={shell} location={{ section: "runs" }}>
      <RunsListView key={JSON.stringify(filter)} initial={runs} suggestions={suggestions} filter={filter} />
    </AppShell>
  );
}
