import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { SearchHome } from "@/components/search/search-home";
import { doneSource, experiments, fixtureShell, people, recentFiles, scanningSource } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { smartExperiments, smartFiles } from "@/fixtures/smart-labels";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { fixtureOnboarding, OnboardingFixture } from "@/fixtures/onboarding";

// "notes": the HeLa drug A runs first, with outcomes, summaries, conditions and a note of 12 pages.
const State = z.enum(["results", "keyword", "empty", "scanning", "new", "notes"]).catch("results");

export default async function SearchFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const params = await searchParams;
  const state = State.parse(params.state);
  const onboarding = fixtureOnboarding(OnboardingFixture.parse(params.onboarding));
  const source = state === "scanning" ? scanningSource : state === "new" ? { kind: "not_connected" as const } : doneSource;
  const isAdmin = onboarding.role === "admin";
  return (
    <FixtureLabApi mode={state === "keyword" ? "keyword" : "hybrid"} source={source}>
      <AppShell
        shell={{ ...fixtureShell, isAdmin, onboarding, needsLookCount: state === "new" ? 0 : fixtureShell.needsLookCount }}
        location={{ section: "search" }}
      >
        <SearchHome
          recent={state === "new" ? [] : state === "notes" ? [...smartFiles, ...recentFiles] : recentFiles}
          source={source}
          isAdmin={isAdmin}
          lists={{ experiments: state === "notes" ? smartExperiments : experiments, people }}
        />
      </AppShell>
    </FixtureLabApi>
  );
}
