import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { TaskView } from "@/components/runs/export/task-page";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { fixtureMe, fixturePeople, fixtureTask, fixtureTaskRun } from "@/fixtures/task-export";
import { FixtureExport } from "@/fixtures/task-export-api";

// The task page (decisions.md, "the run record: de-identification and the task folder"):
// ?view=start (nothing written yet), written (the second scientist's task saved, ready to
// check and build), waiting (sharing off and the cause not attested, seen by a member),
// built (one folder to download, one withdrawn) or demo (a demo lab: SAMPLE, never built).
const View = z.enum(["start", "written", "waiting", "built", "demo"]).catch("start");

export default async function RunExportFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const view = View.parse((await searchParams).view);
  return (
    <FixtureLabApi mode="hybrid" source={doneSource}>
      <AppShell shell={fixtureShell} location={{ section: "runs" }}>
        <FixtureExport view={view}>
          <TaskView run={fixtureTaskRun} initial={fixtureTask(view)} people={fixturePeople} me={fixtureMe} />
        </FixtureExport>
      </AppShell>
    </FixtureLabApi>
  );
}
