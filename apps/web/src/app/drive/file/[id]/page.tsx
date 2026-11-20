import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { driveCrumb } from "@/components/drive/drive-view";
import { FileHistoryView } from "@/components/drive/file-history-view";
import { loadFileHistory, loadVersionDetails } from "@/lib/drive-data";
import { LocationId } from "@/lib/ids";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Versions" };

const VersionNumber = z.string().regex(/^[1-9]\d{0,8}$/).transform(Number);

export default async function FileHistoryPage({ params, searchParams }: PageProps<"/drive/file/[id]">) {
  const id = LocationId.safeParse((await params).id);
  if (!id.success) notFound();
  const asked = (await searchParams).v;
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, versions] = await Promise.all([loadShell(viewer), loadFileHistory(supabase, lab.id, id.data)]);
  const newest = versions.at(-1);
  if (newest === undefined) notFound();
  // No ?v= is the newest; one that names no version of this file is a wrong address.
  const number = asked === undefined ? newest.number : VersionNumber.safeParse(asked).data;
  if (number === undefined || !versions.some((v) => v.number === number)) notFound();
  const details = await loadVersionDetails(supabase, lab.id, versions);
  return (
    <AppShell shell={shell} location={{ section: "browse" }}>
      <FileHistoryView crumbs={[driveCrumb(lab.name, "experiment")]} location={id.data} details={details} shown={number} />
    </AppShell>
  );
}
