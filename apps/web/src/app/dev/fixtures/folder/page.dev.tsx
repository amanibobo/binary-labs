import { FolderView } from "@/app/settings/dropbox/folder/folder-view";
import { AppShell } from "@/components/app-shell";
import { fixtureShell, scanningSource } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures } from "@/fixtures/gate";

export default function FolderFixture() {
  requireFixtures();
  return (
    <FixtureLabApi mode="hybrid" source={scanningSource}>
      <AppShell shell={fixtureShell} location={{ section: "lab" }}>
        <FolderView accountLabel="a.okafor@university.edu" />
      </AppShell>
    </FixtureLabApi>
  );
}
