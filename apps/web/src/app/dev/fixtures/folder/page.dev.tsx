import { FolderView } from "@/app/lab/folder/folder-view";
import { AppShell } from "@/components/app-shell";
import { needsLookFiles, scanningSource } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures } from "@/fixtures/gate";

export default function FolderFixture() {
  requireFixtures();
  return (
    <FixtureLabApi mode="hybrid" source={scanningSource}>
      <AppShell labName="Okafor Lab" email="a.okafor@university.edu" current="lab" needsLookCount={needsLookFiles.length}>
        <FolderView accountLabel="a.okafor@university.edu" />
      </AppShell>
    </FixtureLabApi>
  );
}
