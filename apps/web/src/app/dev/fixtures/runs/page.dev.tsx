import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { RunHistoryView } from "@/components/charts/history-chart";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { fixtureHistory } from "@/fixtures/run-history";

// A check's run history (decisions.md, "charts round 2"): ?view=bradford (ten runs, one flagged,
// one labeled failed, one that couldn't be checked, the range tightened in version 3) or empty
// (a check no run has reached yet).
const View = z.enum(["bradford", "empty"]).catch("bradford");

export default async function RunsFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const view = View.parse((await searchParams).view);
  return (
    <FixtureLabApi mode="hybrid" source={doneSource}>
      <AppShell shell={fixtureShell} location={{ section: "protocols" }}>
        <RunHistoryView history={view === "empty" ? { ...fixtureHistory, runs: [] } : fixtureHistory} />
      </AppShell>
    </FixtureLabApi>
  );
}
