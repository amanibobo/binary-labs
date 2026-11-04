import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { SearchHome } from "@/components/search/search-home";
import { doneSource, experiments, needsLookFiles, people, recentFiles, scanningSource } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";

const State = z.enum(["results", "keyword", "empty", "scanning", "new"]).catch("results");

export default async function SearchFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const state = State.parse((await searchParams).state);
  const source = state === "scanning" ? scanningSource : state === "new" ? { kind: "not_connected" as const } : doneSource;
  return (
    <FixtureLabApi mode={state === "keyword" ? "keyword" : "hybrid"} source={source}>
      <AppShell labName="Okafor Lab" email="a.okafor@university.edu" current="search" needsLookCount={state === "new" ? 0 : needsLookFiles.length}>
        <SearchHome
          labName="Okafor Lab"
          recent={state === "new" ? [] : recentFiles}
          source={source}
          isAdmin
          lists={{ experiments, people }}
        />
      </AppShell>
    </FixtureLabApi>
  );
}
