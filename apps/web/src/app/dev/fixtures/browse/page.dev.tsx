import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { BrowseView } from "@/components/files/browse-view";
import { doneSource, experiments, fixtureShell, folderFixtureFiles, people } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { buildFolderTree, FolderPath } from "@/lib/folders";

export default async function BrowseFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const raw = (await searchParams).path;
  const path = FolderPath.safeParse(typeof raw === "string" ? raw : "");
  const folder = path.success ? buildFolderTree(fixtureShell.folders).byPath.get(path.data) : undefined;
  if (!path.success || folder === undefined) notFound();
  return (
    <FixtureLabApi mode="hybrid" source={doneSource}>
      <AppShell shell={fixtureShell} location={{ section: "browse", folder: path.data }}>
        <BrowseView
          key={path.data}
          labName={fixtureShell.labName}
          folder={folder}
          initialFiles={folderFixtureFiles(path.data, 0)}
          source={doneSource}
          isAdmin
          lists={{ experiments, people }}
        />
      </AppShell>
    </FixtureLabApi>
  );
}
