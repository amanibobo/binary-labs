import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ModelCheckView } from "@/components/runs/model-check/model-check-view";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { fixtureModelChecks } from "@/fixtures/runs-model-check";
import { FixtureModelCheck } from "@/fixtures/runs-model-check-api";

// The model check (decisions.md, "the run record: the model check"): ?view=unset (no keys on
// the worker), ready (a task, not checked yet), checking (two models still answering), checked
// (one answer waits for a second scientist), settled (judged; keep is offered), kept, runner
// (the person who ran it can't judge) or notask (no folder built yet).
const View = z.enum(["unset", "ready", "checking", "checked", "settled", "kept", "runner", "notask"]).catch("checked");

export default async function ModelCheckFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const view = View.parse((await searchParams).view);
  return (
    <FixtureLabApi mode="hybrid" source={doneSource}>
      <FixtureModelCheck view={view}>
        <AppShell shell={fixtureShell} location={{ section: "runs" }}>
          <ModelCheckView initial={fixtureModelChecks(view)} />
        </AppShell>
      </FixtureModelCheck>
    </FixtureLabApi>
  );
}
