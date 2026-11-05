import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ChartBuilder, type BuilderMode } from "@/components/charts/chart-builder";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { BRADFORD, fixtureHit, PLATE, savedCharts, SEC } from "@/fixtures/charts";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { protocolList } from "@/fixtures/protocols";
import type { Sha256 } from "@/lib/ids";

// The chart builder: ?view=new (the plate reader read, as it opens), akta and bradford (the
// other two exports, as they open), saved (the Bradford curve as saved, with error bars),
// sec (the saved SEC trace) and waiting (the worker still reading the table).
const View = z.enum(["new", "akta", "bradford", "saved", "sec", "waiting"]).catch("new");

const FILES: Record<z.infer<typeof View>, Sha256> = {
  new: PLATE,
  akta: SEC,
  bradford: BRADFORD,
  saved: BRADFORD,
  sec: SEC,
  waiting: PLATE,
};

export default async function ChartsFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const view = View.parse((await searchParams).view);
  const sha = FILES[view];
  const location = fixtureHit(sha).locations[0];
  const saved = savedCharts.find((c) => c.sha256 === sha);
  const mode: BuilderMode = (view === "saved" || view === "sec") && saved !== undefined ? { kind: "edit", chart: saved } : { kind: "create", protocolId: null };
  return (
    <FixtureLabApi mode="hybrid" source={doneSource} tables={view === "waiting" ? "waiting" : "ready"}>
      <AppShell shell={fixtureShell} location={{ section: "search" }}>
        <ChartBuilder
          file={{ locationId: location.id, sha256: sha, name: location.originalName }}
          mode={mode}
          protocols={protocolList.map((p) => ({ id: p.id, title: p.title }))}
        />
      </AppShell>
    </FixtureLabApi>
  );
}
