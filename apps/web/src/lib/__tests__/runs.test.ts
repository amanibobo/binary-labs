import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import run1Json from "@/fixtures/tables/growth_flask_run1.json";
import run2Json from "@/fixtures/tables/growth_flask_run2.json";
import run3Json from "@/fixtures/tables/growth_flask_run3.json";
import pendulumJson from "@/fixtures/tables/pendulum.json";
import { chartCsv, exportFigure, figureMarkup } from "@/components/charts/chart-export";
import { describeRuns, startChart } from "../chart-guide";
import { plotChart } from "../chart-geometry";
import { ChartSpec, isXY, withType, type XYSpec } from "../charts";
import { DataTables, mainTable, type DataTable } from "../data-tables";
import { RunId, Sha256 } from "../ids";
import { combineRuns, howItWent, isFailed, type RunInfo } from "../runs";

const doc = (json: unknown) => DataTables.parse(json);
const main = (json: unknown): DataTable => {
  const t = mainTable(doc(json));
  if (t === null) throw new Error("no table");
  return t;
};
const info = (n: number, outcome: RunInfo["outcome"] = "worked"): RunInfo => ({
  sha256: Sha256.parse(String(n).repeat(64)),
  locationId: null,
  name: `growth_flask_run${n}.csv`,
  date: `2026-11-0${n}`,
  outcome,
  experiment: "E. coli growth",
  run: null,
});
const RUN = RunId.parse("7d1c2c39-5a4e-4c55-9d7b-0c3c1a7d0001");
const run1 = main(run1Json);
const line = (): XYSpec => {
  const spec = startChart({ table: run1, tables: [run1], layout: null }, "line");
  if (spec === null || !isXY(spec)) throw new Error("not a line chart");
  return spec;
};

describe("runs on one chart", () => {
  const spec = (): XYSpec => ({ ...line(), runs: [info(2).sha256, info(3).sha256] });
  const others = [
    { run: info(2), doc: doc(run2Json) },
    { run: info(3, "failed"), doc: doc(run3Json) },
  ];

  it("draws each run's OD600 along its own time, named by its run", () => {
    const c = combineRuns(spec(), { run: info(1), table: run1 }, others);
    expect(c.spec.series.map((s) => s.name)).toEqual(["growth_flask_run1", "growth_flask_run2", "growth_flask_run3 (failed)"]);
    expect(c.spec.series[0]?.x).toBeNull();
    expect(c.spec.series[1]?.x).not.toBeNull();
    expect(c.runs.every((r) => r.drawn)).toBe(true);
    const plot = plotChart(c.spec, c.table, { width: 800, height: 400 }, { muted: c.muted });
    expect(plot.series.map((s) => s.points.length)).toEqual([25, 25, 25]);
    // The third run's last point is its own reading, not the first run's.
    const od3 = doc(run3Json).tables[0]?.columns.find((col) => col.name === "OD600");
    expect(plot.series[2]?.points.at(-1)?.y).toBe(od3?.kind === "number" ? od3.values[24] : NaN);
  });

  it("draws a failed run gray and dashed, and keeps it in the legend", () => {
    const c = combineRuns(spec(), { run: info(1), table: run1 }, others);
    const plot = plotChart(c.spec, c.table, { width: 800, height: 400 }, { muted: c.muted });
    expect(plot.series.map((s) => [s.color, s.stroke])).toEqual([
      ["blue", "solid"],
      ["orange", "solid"],
      ["muted", "dashed"],
    ]);
    expect(plot.legend.map((l) => l.color)).toEqual(["blue", "orange", "muted"]);
    const unmuted = plotChart(c.spec, c.table, { width: 800, height: 400 });
    expect(unmuted.series[2]?.color).toBe("aqua");
  });

  it("says which run isn't drawn and why", () => {
    const c = combineRuns(spec(), { run: info(1), table: run1 }, [{ run: info(2), doc: doc(pendulumJson) }, { run: info(3), doc: null }]);
    expect(c.spec.series).toHaveLength(1);
    expect(c.notes).toEqual(["growth_flask_run2 isn't drawn. It has no Time or OD600 column.", "growth_flask_run3 isn't drawn. Its table isn't ready yet."]);
  });

  it("is described, exported and written out with every run", () => {
    const c = combineRuns(spec(), { run: info(1), table: run1 }, others);
    expect(describeRuns(c)).toBe("OD600 as Time goes from 0 to 12 h, for 3 runs: growth_flask_run1, growth_flask_run2 and growth_flask_run3 (failed). The run labeled failed is drawn gray and dashed, not left out.");
    const file = figureMarkup(exportFigure(c.spec, c.table, "Three flasks", "column", [c.table], c.muted), renderToStaticMarkup);
    expect(file.markup).toContain('stroke="#66666c"');
    expect(file.markup).toContain("growth_flask_run3 (failed)");
    const csv = chartCsv(c.spec, c.table, "Three flasks", []).split("\r\n");
    expect(csv[3]).toBe("growth_flask_run1: Time (h),growth_flask_run1: OD600,growth_flask_run2: Time (h),growth_flask_run2: OD600,growth_flask_run3: Time (h),growth_flask_run3: OD600");
  });

  it("keeps runs on a scatter and drops them for bars, which can't draw them", () => {
    const s = spec();
    expect(ChartSpec.safeParse(s).success).toBe(true);
    const runsOf = (c: ChartSpec) => (isXY(c) ? c.runs : "not an x/y chart");
    expect(runsOf(withType(s, "scatter", run1, null))).toHaveLength(2);
    expect(runsOf(withType(s, "bar", run1, null))).toBeUndefined();
  });
});

describe("how a run went", () => {
  it("is what the file's label says while the file is in no run", () => {
    expect(isFailed(info(1, "failed"))).toBe(true);
    expect(isFailed(info(1, "worked"))).toBe(false);
    expect(isFailed(undefined)).toBe(false);
    expect(howItWent(info(1, "unclear"))).toBe("unclear");
  });

  it("is the run's status once the file belongs to a run, whatever the label says", () => {
    expect(isFailed({ ...info(1, "worked"), run: { id: RUN, status: "failed" } })).toBe(true);
    expect(isFailed({ ...info(1, "failed"), run: { id: RUN, status: "worked" } })).toBe(false);
    expect(isFailed({ ...info(1, "failed"), run: { id: RUN, status: "odd" } })).toBe(false);
    // A run nobody has marked hasn't failed, even if its file's label says so.
    expect(isFailed({ ...info(1, "failed"), run: { id: RUN, status: null } })).toBe(false);
    expect(howItWent({ ...info(1, "failed"), run: { id: RUN, status: null } })).toBeNull();
  });

  it("draws a file gray and dashed by its run's status", () => {
    const spec: XYSpec = { ...line(), runs: [info(2).sha256, info(3).sha256] };
    const c = combineRuns(spec, { run: info(1), table: run1 }, [
      { run: { ...info(2, "worked"), run: { id: RUN, status: "failed" } }, doc: doc(run2Json) },
      { run: { ...info(3, "failed"), run: { id: RUN, status: "worked" } }, doc: doc(run3Json) },
    ]);
    expect(c.spec.series.map((s) => s.name)).toEqual(["growth_flask_run1", "growth_flask_run2 (failed)", "growth_flask_run3"]);
    expect(c.muted.size).toBe(1);
  });
});
