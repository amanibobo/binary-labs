import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { DriveFolderView } from "@/components/drive/drive-folder-view";
import { driveCrumb } from "@/components/drive/drive-view";
import { DriveBy, driveFolderHref, driveFolderName, driveKeyFromSegment } from "@/lib/drive";
import { loadDriveFiles, loadDriveFolders } from "@/lib/drive-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Lab drive" };

const From = z.string().regex(/^\d{1,9}$/).transform(Number).catch(0);

export default async function DriveFolderPage({ params, searchParams }: PageProps<"/drive/[by]/[key]">) {
  const segments = await params;
  const by = DriveBy.safeParse(segments.by);
  const key = driveKeyFromSegment(decodeURIComponent(segments.key));
  if (!by.success || key === null) notFound();
  const from = From.parse((await searchParams).from);
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, folders, files] = await Promise.all([
    loadShell(viewer),
    loadDriveFolders(supabase, lab.id, by.data),
    loadDriveFiles(supabase, lab.id, by.data, key, from),
  ]);
  const folder = folders.find((f) => f.key === key);
  if (folder === undefined) notFound();
  const name = driveFolderName(by.data, folder);
  return (
    <AppShell shell={shell} location={{ section: "browse" }}>
      <DriveFolderView
        key={`${by.data}/${key}/${from}`}
        crumbs={[driveCrumb(lab.name, by.data), { label: name, href: driveFolderHref(by.data, key) }]}
        name={name}
        by={by.data}
        folderKey={key}
        files={files}
        from={from}
        total={folder.files}
      />
    </AppShell>
  );
}
