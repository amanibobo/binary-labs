import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { RunView } from "@/components/runs/run-page";
import { RunsListView } from "@/components/runs/runs-list";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { FIRST_TRY, fixtureRuns, fixtureSuggestions, RETRY, rowOf, UNMARKED } from "@/fixtures/runs";

// The run record (decisions.md, "the run record: foundation"): ?view=list (the lab's runs with
// "Turn these into runs?" above them), empty (no runs yet), failed (a run that failed, with a
// shared control), retry (a retry that worked, its status read from the file) or unmarked
// (nobody has said; one file removed from the lab, one still being saved).
const View = z.enum(["list", "empty", "failed", "retry", "unmarked"]).catch("list");
const RUN_OF = { failed: FIRST_TRY, retry: RETRY, unmarked: UNMARKED } as const;

export default async function RunRecordsFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const view = View.parse((await searchParams).view);
  const run = view === "list" || view === "empty" ? undefined : fixtureRuns.find((r) => r.id === RUN_OF[view]);
  return (
    <FixtureLabApi mode="hybrid" source={doneSource}>
      <AppShell shell={fixtureShell} location={{ section: "runs" }}>
        {run === undefined ? (
          <RunsListView initial={view === "empty" ? [] : fixtureRuns.map(rowOf)} suggestions={view === "empty" ? [] : fixtureSuggestions} filter={{}} />
        ) : (
          <RunView initial={run} />
        )}
      </AppShell>
    </FixtureLabApi>
  );
}
