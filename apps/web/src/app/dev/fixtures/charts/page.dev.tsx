import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ChartBuilder, type BuilderMode } from "@/components/charts/chart-builder";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { BIOREACTOR, BRADFORD, ELISA, fixtureFile, PLATE, savedChart, SEC } from "@/fixtures/charts";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { protocolList } from "@/fixtures/protocols";
import type { Sha256 } from "@/lib/ids";

// The chart builder: ?view=new (the plate reader read, as it opens), akta, bradford, dates
// (the bioreactor log) and elisa (a list of wells) as they open; saved (the Bradford curve as
// saved, with error bars), sec (the saved SEC trace, A260 on its own volume column),
// sec-cond (conductivity on its own volume column), growth (the bioreactor on a time axis),
// plate (the ELISA plate saved), plate-read (plate 7 at its last read), lines (ten wells,
// four dashed), broken (a saved chart whose column went when the file was read again) and
// waiting (the worker still reading the table).
const View = z
  .enum(["new", "akta", "bradford", "dates", "elisa", "saved", "sec", "sec-cond", "growth", "plate", "plate-read", "lines", "broken", "waiting"])
  .catch("new");

const NEW: Partial<Record<z.infer<typeof View>, Sha256>> = { new: PLATE, akta: SEC, bradford: BRADFORD, dates: BIOREACTOR, elisa: ELISA, waiting: PLATE };
const SAVED: Partial<Record<z.infer<typeof View>, number>> = { saved: 1, sec: 2, "sec-cond": 4, growth: 5, plate: 6, lines: 7, "plate-read": 8, broken: 9 };

export default async function ChartsFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const view = View.parse((await searchParams).view);
  const n = SAVED[view];
  const chart = n === undefined ? null : savedChart(n);
  const sha = chart?.sha256 ?? NEW[view] ?? PLATE;
  const mode: BuilderMode = chart === null ? { kind: "create", protocolId: null } : { kind: "edit", chart };
  return (
    <FixtureLabApi mode="hybrid" source={doneSource} tables={view === "waiting" ? "waiting" : "ready"}>
      <AppShell shell={fixtureShell} location={{ section: "search" }}>
        <ChartBuilder file={fixtureFile(sha)} mode={mode} protocols={protocolList.map((p) => ({ id: p.id, title: p.title }))} />
      </AppShell>
    </FixtureLabApi>
  );
}
