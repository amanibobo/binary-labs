import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { BrowseView } from "@/components/files/browse-view";
import { ConfigMissing } from "@/components/config-missing";
import { buildFolderTree, folderName, folderPathFromSegments } from "@/lib/folders";
import { loadExperiments, loadFolderFiles, loadPeople, loadSourceState } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export async function generateMetadata({ params }: PageProps<"/browse/[[...path]]">): Promise<Metadata> {
  const path = folderPathFromSegments((await params).path);
  return { title: path === null || path === "" ? "Browse" : folderName(path) };
}

export default async function BrowsePage({ params }: PageProps<"/browse/[[...path]]">) {
  const path = folderPathFromSegments((await params).path);
  if (path === null) notFound();
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, files, source, experiments, people] = await Promise.all([
    loadShell(viewer),
    loadFolderFiles(supabase, lab.id, path, 0),
    loadSourceState(supabase, lab.id),
    loadExperiments(supabase, lab.id),
    loadPeople(supabase, lab.id),
  ]);
  const folder = buildFolderTree(shell.folders).byPath.get(path);
  if (folder === undefined) notFound();
  return (
    <AppShell shell={shell} location={{ section: "browse", folder: path }}>
      <BrowseView
        key={path}
        labName={lab.name}
        folder={folder}
        initialFiles={files}
        source={source}
        isAdmin={lab.role === "admin"}
        lists={{ experiments, people }}
      />
    </AppShell>
  );
}
