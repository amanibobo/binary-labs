import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { RunView } from "@/components/runs/run-page";
import { RunId } from "@/lib/ids";
import { loadRun } from "@/lib/run-record-store";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Run" };

export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  const id = RunId.safeParse((await params).id);
  if (!id.success) notFound();
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const [shell, run] = await Promise.all([loadShell(viewer), loadRun(viewer.supabase, id.data)]);
  // Another lab's run reads as no run at all.
  if (run === null) notFound();
  return (
    <AppShell shell={shell} location={{ section: "runs" }}>
      <RunView initial={run} />
    </AppShell>
  );
}
