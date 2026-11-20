import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { DriveFolderView } from "@/components/drive/drive-folder-view";
import { driveCrumb, DriveView } from "@/components/drive/drive-view";
import { FileHistoryView } from "@/components/drive/file-history-view";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { driveFiles, driveFolders, driveMonths, historyDetails, historyLocation } from "@/fixtures/drive";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { driveFolderHref, driveFolderName } from "@/lib/drive";

// ?view=root (or by=month), folder, file (with v= for an older version).
export default async function DriveFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const params = await searchParams;
  const view = typeof params.view === "string" ? params.view : "root";
  const folder = driveFolders[1];
  if (folder === undefined) notFound();
  const lab = fixtureShell.labName;
  const crumbs = [driveCrumb(lab, "experiment")];
  return (
    <FixtureLabApi mode="hybrid" source={doneSource}>
      <AppShell shell={fixtureShell} location={{ section: "browse" }}>
        {view === "folder" ? (
          <DriveFolderView
            crumbs={[...crumbs, { label: driveFolderName("experiment", folder), href: driveFolderHref("experiment", folder.key) }]}
            name={driveFolderName("experiment", folder)}
            by="experiment"
            folderKey={folder.key}
            files={driveFiles}
            from={0}
            total={driveFiles.length}
          />
        ) : view === "file" ? (
          <FileHistoryView crumbs={crumbs} location={historyLocation} details={historyDetails} shown={Number(params.v ?? historyDetails.length)} />
        ) : params.by === "month" ? (
          <DriveView labName={lab} by="month" folders={driveMonths} />
        ) : (
          <DriveView labName={lab} by="experiment" folders={driveFolders} />
        )}
      </AppShell>
    </FixtureLabApi>
  );
}
