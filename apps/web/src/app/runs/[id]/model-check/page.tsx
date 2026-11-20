import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { ModelCheckView } from "@/components/runs/model-check/model-check-view";
import { RunId } from "@/lib/ids";
import { loadModelChecks } from "@/lib/model-check-store";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Model check" };

export default async function ModelCheckPage({ params }: PageProps<"/runs/[id]/model-check">) {
  const id = RunId.safeParse((await params).id);
  if (!id.success) notFound();
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const [shell, checks] = await Promise.all([loadShell(viewer), loadModelChecks(viewer.supabase, id.data)]);
  // Another lab's run reads as no run at all.
  if (checks === null) notFound();
  return (
    <AppShell shell={shell} location={{ section: "runs" }}>
      <ModelCheckView initial={checks} />
    </AppShell>
  );
}
