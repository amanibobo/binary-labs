import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { FailureFixtureView } from "@/fixtures/runs-failure-view";
import { RunListFilter } from "@/lib/run-record";

// The failure record (decisions.md, "the run record: the failure record"): ?view=yours (the
// first try, its cause confirmed by Ade naming Priya, who is looking and hasn't said yes) or
// unlinked (the same cause naming Jordan, who has no account, seen from Jordan's own account,
// which can say "This is me"), or list (the runs list, filtered by the address as /runs is:
// ?technique=, ?step=, ?cause=).
const View = z.enum(["yours", "unlinked", "list"]).catch("yours");

export default async function RunFailureFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const query = await searchParams;
  const view = View.parse(query.view);
  const filter = RunListFilter.catch({}).parse(query);
  return (
    <FixtureLabApi mode="hybrid" source={doneSource}>
      <AppShell shell={fixtureShell} location={{ section: "runs" }}>
        <FailureFixtureView key={`${view}:${JSON.stringify(filter)}`} view={view} filter={filter} />
      </AppShell>
    </FixtureLabApi>
  );
}
