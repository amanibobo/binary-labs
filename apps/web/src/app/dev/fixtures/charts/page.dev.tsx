import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ChartBuilder, type BuilderMode } from "@/components/charts/chart-builder";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { BIOREACTOR, BRADFORD, BRADFORD_PLATE, CELLS, DOSE, DOSE_LAYOUT, ELISA, fixtureFile, FLASK1, GROUPS, GROWTH, KNOCKDOWN, LINES, PENDULUM, PLATE, savedChart, SEC } from "@/fixtures/charts";
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
// waiting (the worker still reading the table). Charts of repeats (decisions.md, "charts round
// 1"): dose (a viability plate whose export carries its layout), dose-paint (the same plate to
// mark by hand), bradford-plate (standards, blanks and samples listed by well), knockdown (two
// groups), groups (four, long format), growth-reps (a growth curve in triplicate), cells (200
// cell sizes), pendulum (not biology) and saved-dose (the worked example, saved). Round 2: grid
// (viability of four cell lines by day), runs (the first of three flask runs; the third failed)
// and cited (the first run opened from an answer that cited its OD600 in row 13).
const View = z
  .enum([
    "new",
    "akta",
    "bradford",
    "dates",
    "elisa",
    "saved",
    "sec",
    "sec-cond",
    "growth",
    "plate",
    "plate-read",
    "lines",
    "broken",
    "waiting",
    "dose",
    "dose-paint",
    "bradford-plate",
    "knockdown",
    "groups",
    "growth-reps",
    "cells",
    "pendulum",
    "saved-dose",
    "grid",
    "runs",
    "cited",
  ])
  .catch("new");

const NEW: Partial<Record<z.infer<typeof View>, Sha256>> = {
  new: PLATE,
  akta: SEC,
  bradford: BRADFORD,
  dates: BIOREACTOR,
  elisa: ELISA,
  waiting: PLATE,
  dose: DOSE_LAYOUT,
  "dose-paint": DOSE,
  "bradford-plate": BRADFORD_PLATE,
  knockdown: KNOCKDOWN,
  groups: GROUPS,
  "growth-reps": GROWTH,
  cells: CELLS,
  pendulum: PENDULUM,
  grid: LINES,
  runs: FLASK1,
  cited: FLASK1,
};
const SAVED: Partial<Record<z.infer<typeof View>, number>> = { saved: 1, sec: 2, "sec-cond": 4, growth: 5, plate: 6, lines: 7, "plate-read": 8, broken: 9, "saved-dose": 10 };

export default async function ChartsFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const view = View.parse((await searchParams).view);
  const n = SAVED[view];
  const chart = n === undefined ? null : savedChart(n);
  const sha = chart?.sha256 ?? NEW[view] ?? PLATE;
  const mode: BuilderMode =
    chart === null
      ? { kind: "create", protocolId: null, cited: view === "cited" ? { sheet: "Table 1", column: "OD600", row: 13 } : null }
      : { kind: "edit", chart, provenance: view === "saved-dose" ? { protocolVersion: { version: 3, title: "Cell viability (MTT)" }, layoutName: "Drug A, 5 doses by fives" } : undefined };
  return (
    <FixtureLabApi mode="hybrid" source={doneSource} tables={view === "waiting" ? "waiting" : "ready"}>
      <AppShell shell={fixtureShell} location={{ section: "search" }}>
        <ChartBuilder file={fixtureFile(sha)} mode={mode} protocols={protocolList.map((p) => ({ id: p.id, title: p.title }))} />
      </AppShell>
    </FixtureLabApi>
  );
}
